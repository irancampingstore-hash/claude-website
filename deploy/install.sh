#!/usr/bin/env bash
# Iran Camping MCP Hub — one-command installer for Ubuntu/Debian.
#
#   sudo bash install.sh --domain server1.iranoutdoor.com [--email you@example.com] [--with-bridge] [--vps-local]
#   bash install.sh --preflight-only                  # only test connectivity / environment, change nothing
#   sudo bash install.sh --dry-run --domain x.example # print what would be done
#
# Idempotent: safe to run again (it keeps your .env, users and data). Nothing is deleted.
set -euo pipefail

DOMAIN=""; EMAIL=""; TLS="auto"; DIR="/opt/iran-camping-hub"; SVC_USER="mcphub"
WITH_BRIDGE=0; VPS_LOCAL=0; DRY=0; PREFLIGHT_ONLY=0
NO_PACKAGES=0; NO_SYSTEMD=0; NO_PROXY=0; NO_USER=0; PORT=8787
NODE_MAJOR=22
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

c_ok=$'\e[32m'; c_warn=$'\e[33m'; c_err=$'\e[31m'; c_dim=$'\e[2m'; c_off=$'\e[0m'
ok()   { echo "${c_ok}✔${c_off} $*"; }
warn() { echo "${c_warn}⚠${c_off} $*"; }
err()  { echo "${c_err}✘${c_off} $*" >&2; }
step() { echo; echo "── $* ──"; }
run()  { if [ "$DRY" = 1 ]; then echo "${c_dim}[dry-run] $*${c_off}"; else "$@"; fi; }

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2;;
    --email) EMAIL="$2"; shift 2;;
    --tls) TLS="$2"; shift 2;;                 # auto | letsencrypt | none (= do not run certbot; TLS is handled in front of this server)
    --dir) DIR="$2"; shift 2;;
    --port) PORT="$2"; shift 2;;
    --with-bridge) WITH_BRIDGE=1; shift;;
    --vps-local) VPS_LOCAL=1; shift;;
    --dry-run) DRY=1; shift;;
    --preflight-only) PREFLIGHT_ONLY=1; shift;;
    --no-packages) NO_PACKAGES=1; shift;;
    --no-systemd) NO_SYSTEMD=1; shift;;
    --no-proxy) NO_PROXY=1; shift;;
    --no-user) NO_USER=1; shift;;
    -h|--help) sed -n '2,10p' "$0"; exit 0;;
    *) err "Unknown option: $1"; exit 2;;
  esac
done

# ───────────────────────── privileges ─────────────────────────
SUDO=""
if [ "$(id -u)" != "0" ]; then
  if sudo -n true 2>/dev/null; then SUDO="sudo"
  elif [ "$PREFLIGHT_ONLY" = 1 ] || [ "$DRY" = 1 ]; then warn "Not root and no passwordless sudo — continuing read-only."
  else err "Run as root (or a user with passwordless sudo): sudo bash $0 $*"; exit 1; fi
fi
as_root() { if [ -n "$SUDO" ]; then run $SUDO "$@"; else run "$@"; fi; }

# ───────────────────────── 1. preflight ─────────────────────────
preflight() {
  step "Environment"
  . /etc/os-release 2>/dev/null && ok "OS: ${PRETTY_NAME:-unknown}" || warn "Unknown OS"
  [ "$(uname -m)" = "x86_64" ] && ok "CPU: x86_64" || warn "CPU is $(uname -m) — the Node tarball step assumes x86_64"
  command -v systemctl >/dev/null && ok "systemd present" || warn "no systemd (use --no-systemd and run 'node dist/server.js' yourself)"
  local ram; ram=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)
  [ "$ram" -ge 512 ] && ok "RAM: ${ram} MB" || warn "RAM only ${ram} MB (hub needs ~150 MB; bridge ~250 MB)"
  local free; free=$(df -Pm / 2>/dev/null | awk 'NR==2 {print $4}' || echo 0)
  [ "${free:-0}" -ge 1500 ] && ok "Disk free: ${free} MB" || warn "Disk free only ${free} MB"

  step "Outbound connectivity (an HTTP code of any kind = reachable; 000 = blocked)"
  local hosts=(https://www.instagram.com/ https://i.instagram.com/api/v1/ https://graph.instagram.com/ https://irancamping.com/ https://nodejs.org/ https://registry.npmjs.org/ https://pypi.org/ https://github.com/ https://api.anthropic.com/ https://api.openai.com/)
  for u in "${hosts[@]}"; do
    local out; out=$(curl -sS -o /dev/null -w "%{http_code} %{time_total}s" --max-time 12 "$u" 2>&1 | tail -1 || true)
    case "$out" in
      000*|*"timed out"*|*"reset"*|*"resolve"*|*"refused"*) printf "  ${c_err}✘${c_off} %-38s %s\n" "$u" "BLOCKED ($out)";;
      *) printf "  ${c_ok}✔${c_off} %-38s %s\n" "$u" "$out";;
    esac
  done
  for h in www.instagram.com i.instagram.com; do
    local ip; ip=$(getent hosts "$h" 2>/dev/null | awk '{print $1; exit}' || true)
    case "$ip" in 10.10.34.*) warn "$h resolves to $ip — that is the national filtering address (blocked at DNS level)";; esac
  done

  step "Ports and web server"
  for p in 80 443 "$PORT"; do
    local who; who=$(ss -ltnpH "sport = :$p" 2>/dev/null | head -1 | sed -E 's/.*users:\(\("([^"]+)".*/\1/' || true)
    [ -n "$who" ] && warn "port $p is used by: $who" || ok "port $p is free"
  done
  if [ -n "$DOMAIN" ]; then
    local dns; dns=$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1; exit}' || true)
    local mine; mine=$(hostname -I 2>/dev/null || true)
    if [ -z "$dns" ]; then err "$DOMAIN does not resolve"; elif echo " $mine " | grep -q " $dns "; then ok "$DOMAIN → $dns (this server)"; else warn "$DOMAIN → $dns, which is not one of this server's addresses ($mine) — fine only if behind NAT/panel; HTTPS issuance needs it to reach this server"; fi
  fi
  for t in node npm git nginx python3; do command -v "$t" >/dev/null && ok "$t: $("$t" --version 2>&1 | head -1)" || echo "  - $t not installed"; done
}

if [ "$PREFLIGHT_ONLY" = 1 ]; then preflight; exit 0; fi
[ -n "$DOMAIN" ] || [ "$NO_PROXY" = 1 ] || { err "--domain is required (or pass --no-proxy to run without HTTPS front-end)"; exit 2; }
preflight

# ───────────────────────── 2. packages ─────────────────────────
step "System packages"
if [ "$NO_PACKAGES" = 1 ]; then warn "skipped (--no-packages)"; else
  pk=(curl ca-certificates xz-utils tar)
  [ "$NO_PROXY" = 1 ] || pk+=(nginx)
  [ "$NO_PROXY" = 1 ] || [ "$TLS" = "none" ] || pk+=(certbot python3-certbot-nginx)
  [ "$WITH_BRIDGE" = 1 ] && pk+=(python3 python3-venv python3-pip)
  as_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq || warn "apt-get update failed (mirror blocked?) — continuing with what is installed"
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${pk[@]}" || warn "some packages failed to install; see messages above"
fi

# ───────────────────────── 3. Node.js ─────────────────────────
step "Node.js ≥ ${NODE_MAJOR}"
have_node() { command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge "$NODE_MAJOR" ] 2>/dev/null; }
if have_node; then ok "found $(node -v)"; else
  if [ -x "$SRC/vendor/node/bin/node" ]; then ok "using bundled Node from the release"; as_root ln -sf "$SRC/vendor/node/bin/node" /usr/local/bin/node
  else
    tmp=$(mktemp -d); base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
    if [ "$DRY" = 1 ]; then echo "${c_dim}[dry-run] download latest Node ${NODE_MAJOR} from $base and verify sha256${c_off}"; else
      line=$(curl -fsS --max-time 30 "$base/SHASUMS256.txt" | grep 'linux-x64.tar.xz$') || { err "cannot reach nodejs.org. Put a Node ${NODE_MAJOR} linux-x64 tarball's contents in <release>/vendor/node (see docs/DEPLOY.md) and re-run."; exit 1; }
      sum=${line%% *}; file=${line##* }
      curl -fsS --max-time 300 -o "$tmp/$file" "$base/$file"
      echo "$sum  $tmp/$file" | sha256sum -c - >/dev/null && ok "checksum verified ($file)" || { err "checksum mismatch"; exit 1; }
      as_root tar -xJf "$tmp/$file" -C /usr/local --strip-components=1
      ok "installed $(/usr/local/bin/node -v)"
    fi
  fi
fi

# ───────────────────────── 4. user + files ─────────────────────────
step "Application files → $DIR"
if [ "$NO_USER" = 0 ]; then
  id "$SVC_USER" >/dev/null 2>&1 || as_root useradd --system --create-home --shell /usr/sbin/nologin "$SVC_USER"
  ok "service user: $SVC_USER"
else SVC_USER="$(id -un)"; warn "running as current user ($SVC_USER)"; fi
as_root mkdir -p "$DIR"
if [ "$SRC" != "$DIR" ]; then
  # copy the release, but never overwrite local state
  as_root tar -C "$SRC" --exclude='./data' --exclude='./.env' --exclude='./agents.json' --exclude='./ig-bridge/data' --exclude='./ig-bridge/.venv' --exclude='./.git' -cf - . | as_root tar -C "$DIR" -xf -
fi
as_root mkdir -p "$DIR/data"
[ "$NO_USER" = 1 ] || as_root chown -R "$SVC_USER":"$SVC_USER" "$DIR"
ok "files in place"

as_user() { if [ "$NO_USER" = 1 ] || [ "$DRY" = 1 ]; then run "$@"; elif [ -n "$SUDO" ]; then run sudo -u "$SVC_USER" "$@"; else run runuser -u "$SVC_USER" -- "$@"; fi; }
if [ ! -d "$DIR/node_modules/@modelcontextprotocol" ]; then
  step "Installing npm dependencies"
  as_user bash -c "cd '$DIR' && npm ci --omit=dev --no-audit --no-fund" || { err "npm install failed (registry blocked?). Build the release on your PC with deploy/make-release.mjs — it bundles node_modules."; exit 1; }
fi
[ -f "$DIR/dist/server.js" ] || { err "dist/server.js missing — use a release built by deploy/make-release.mjs, or run 'npm run build' first."; exit 1; }

# ───────────────────────── 5. configuration ─────────────────────────
step "Configuration (.env)"
ENVF="$DIR/.env"
rand() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
setenv() { # setenv KEY VALUE [empty]  — replace the first KEY= line (or its commented form); "empty" keeps an existing value
  local k="$1" v="$2" mode="${3:-set}" tmp line replaced=0
  if [ "$DRY" = 1 ]; then echo "${c_dim}[dry-run] .env: $k=…${c_off}"; return; fi
  tmp=$(mktemp)
  while IFS= read -r line || [ -n "$line" ]; do
    if [ "$replaced" = 0 ] && [[ "$line" =~ ^\#?[[:space:]]*$k= ]]; then
      replaced=1
      if [ "$mode" = "empty" ] && [[ "$line" =~ ^$k=.+ ]]; then printf '%s\n' "$line" >> "$tmp"; else printf '%s=%s\n' "$k" "$v" >> "$tmp"; fi
    else printf '%s\n' "$line" >> "$tmp"; fi
  done < "$ENVF"
  [ "$replaced" = 1 ] || printf '%s=%s\n' "$k" "$v" >> "$tmp"
  cat "$tmp" > "$ENVF"; rm -f "$tmp"
}
if [ ! -f "$ENVF" ]; then as_root cp "$DIR/.env.example" "$ENVF"; fi
if [ "$DRY" = 0 ]; then
  setenv HUB_SECRET "$(rand)" empty
  setenv PC_AGENT_TOKEN "$(rand)" empty
  setenv PORT "$PORT"
  setenv HUB_TRUST_PROXY 1
  # The PUBLIC url is always https:// (OAuth requires it), even when TLS is terminated by a panel/Cloudflare in front of nginx.
  [ -n "$DOMAIN" ] && { setenv HUB_PUBLIC_URL "https://$DOMAIN"; setenv VPS_SITE_URL "https://${DOMAIN#server1.}"; }
  if [ "$VPS_LOCAL" = 1 ]; then
    setenv VPS_MODE local
    svcs=""; for s in nginx apache2 httpd mysql mariadb $(systemctl list-unit-files --no-legend 2>/dev/null | awk '{print $1}' | grep -E '^php[0-9.]*-fpm\.service$' | sed 's/\.service$//'); do
      systemctl list-unit-files --no-legend 2>/dev/null | grep -q "^$s.service" && svcs="${svcs:+$svcs,}$s"; done
    [ -n "$svcs" ] && setenv VPS_SERVICES "$svcs" && ok "detected services: $svcs"
  fi
  if [ "$WITH_BRIDGE" = 1 ]; then
    tok=$(grep -E '^IG_BRIDGE_TOKEN=.+' "$ENVF" | cut -d= -f2- || true); [ -n "$tok" ] || tok=$(rand)
    setenv IG_BRIDGE_TOKEN "$tok"; setenv IG_BRIDGE_URL "http://127.0.0.1:8791"
  fi
  chmod 600 "$ENVF"; [ "$NO_USER" = 1 ] || chown "$SVC_USER":"$SVC_USER" "$ENVF"
fi
[ -f "$DIR/agents.json" ] || as_root cp "$DIR/agents.example.json" "$DIR/agents.json"
[ "$NO_USER" = 1 ] || as_root chown "$SVC_USER":"$SVC_USER" "$DIR/agents.json"
ok ".env written (secrets generated; existing values kept)"

# ───────────────────────── 6. first user ─────────────────────────
step "Owner account"
if [ "$DRY" = 1 ]; then echo "${c_dim}[dry-run] create user 'owner' if missing${c_off}"; else
  if as_user bash -c "cd '$DIR' && NODE_NO_WARNINGS=1 node dist/cli.js user list" 2>/dev/null | grep -q ' owner '; then ok "owner already exists"; else
    out=$(as_user bash -c "cd '$DIR' && NODE_NO_WARNINGS=1 node dist/cli.js user add --name owner --role owner")
    key=$(echo "$out" | grep -oE 'icm_[A-Za-z0-9_-]+' | head -1)
    kf="/root/iran-camping-owner-key.txt"; [ "$(id -u)" = "0" ] || kf="$HOME/iran-camping-owner-key.txt"
    ( umask 077; echo "$key" > "$kf" )
    ok "owner created. ACCESS KEY (also saved to $kf — delete after copying):"; echo; echo "    $key"; echo
  fi
fi

# ───────────────────────── 7. ig-bridge ─────────────────────────
if [ "$WITH_BRIDGE" = 1 ]; then
  step "Instagram bridge (instagrapi)"
  as_user bash -c "cd '$DIR/ig-bridge' && python3 -m venv .venv && ( [ -d wheels ] && .venv/bin/pip install -q --no-index --find-links wheels -r requirements.txt || .venv/bin/pip install -q -r requirements.txt )" \
    && ok "bridge dependencies installed" \
    || { err "pip install failed (PyPI blocked or Python too new for the wheels). See ig-bridge/README.md; the hub works without the bridge."; WITH_BRIDGE=0; }
  if [ "$WITH_BRIDGE" = 1 ] && [ "$DRY" = 0 ]; then
    tok=$(grep -E '^IG_BRIDGE_TOKEN=' "$ENVF" | cut -d= -f2-)
    printf 'IG_BRIDGE_TOKEN=%s\nIG_BRIDGE_DATA=%s/ig-bridge/data\nIG_BRIDGE_HOST=127.0.0.1\nIG_BRIDGE_PORT=8791\n' "$tok" "$DIR" > "$DIR/ig-bridge/bridge.env"
    chmod 600 "$DIR/ig-bridge/bridge.env"; [ "$NO_USER" = 1 ] || chown "$SVC_USER":"$SVC_USER" "$DIR/ig-bridge/bridge.env"
  fi
fi

# ───────────────────────── 8. systemd ─────────────────────────
step "Services"
if [ "$NO_SYSTEMD" = 1 ] || ! command -v systemctl >/dev/null; then
  warn "systemd skipped. Start manually:  cd $DIR && node dist/server.js   (it reads .env itself)"
else
  NODE_BIN=$(command -v node)
  unit_hub="[Unit]
Description=Iran Camping MCP Hub
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
WorkingDirectory=$DIR
EnvironmentFile=$DIR/.env
Environment=NODE_ENV=production
Environment=NODE_NO_WARNINGS=1
ExecStart=$NODE_BIN dist/server.js
Restart=always
RestartSec=3
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=$DIR/data
# NoNewPrivileges stays off: vps_service_control uses 'sudo -n systemctl …' (narrow sudoers rule)

[Install]
WantedBy=multi-user.target
"
  if [ "$DRY" = 1 ]; then echo "${c_dim}[dry-run] write /etc/systemd/system/iran-camping-hub.service and enable --now${c_off}"; else
    echo "$unit_hub" | as_root tee /etc/systemd/system/iran-camping-hub.service >/dev/null
    if [ "$WITH_BRIDGE" = 1 ]; then
      echo "[Unit]
Description=Iran Camping Instagram bridge
After=network-online.target

[Service]
User=$SVC_USER
WorkingDirectory=$DIR/ig-bridge
EnvironmentFile=$DIR/ig-bridge/bridge.env
ExecStart=$DIR/ig-bridge/.venv/bin/python -m bridge
Restart=always
RestartSec=5
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=$DIR/ig-bridge/data

[Install]
WantedBy=multi-user.target" | as_root tee /etc/systemd/system/iran-camping-bridge.service >/dev/null
    fi
    # narrow sudo rule so the hub (non-root) can restart only the services it manages
    if [ "$VPS_LOCAL" = 1 ] && [ "$NO_USER" = 0 ]; then
      rules=""; for s in $(grep -E '^VPS_SERVICES=' "$ENVF" | cut -d= -f2- | tr ',' ' '); do rules="${rules:+$rules, }/usr/bin/systemctl restart $s, /usr/bin/systemctl reload $s, /usr/bin/systemctl start $s, /usr/bin/systemctl stop $s"; done
      nginx_bin=$(command -v nginx || true); [ -n "$nginx_bin" ] && rules="${rules:+$rules, }$nginx_bin -t"
      if [ -n "$rules" ]; then
        echo "$SVC_USER ALL=(root) NOPASSWD: $rules" | as_root tee /etc/sudoers.d/iran-camping-hub >/dev/null
        as_root chmod 440 /etc/sudoers.d/iran-camping-hub
        as_root visudo -cf /etc/sudoers.d/iran-camping-hub >/dev/null && ok "sudoers rule installed (restart/reload of managed services only)" || { as_root rm -f /etc/sudoers.d/iran-camping-hub; warn "sudoers rule was invalid and removed"; }
      fi
    fi
    as_root systemctl daemon-reload
    as_root systemctl enable --now iran-camping-hub
    [ "$WITH_BRIDGE" = 1 ] && as_root systemctl enable --now iran-camping-bridge
    for i in $(seq 1 20); do curl -fsS --max-time 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 1; done
    curl -fsS --max-time 3 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && ok "hub is up on 127.0.0.1:$PORT" || { err "hub did not start. Look: journalctl -u iran-camping-hub -n 50 --no-pager"; exit 1; }
  fi
fi

# ───────────────────────── 9. reverse proxy + HTTPS ─────────────────────────
step "Reverse proxy"
nginx_conf="server {
    listen 80;
    server_name $DOMAIN;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_buffering off;
        proxy_read_timeout 330s;
        client_max_body_size 5m;
    }
}
map \$http_upgrade \$connection_upgrade { default upgrade; '' close; }
"
if [ "$NO_PROXY" = 1 ]; then warn "skipped (--no-proxy). Point your existing web server at http://127.0.0.1:$PORT (see $DIR/deploy/nginx.conf)"; else
  p80=$(ss -ltnpH "sport = :80" 2>/dev/null | head -1 || true)
  if [ -n "$p80" ] && ! echo "$p80" | grep -q nginx; then
    warn "port 80 is used by another web server (a control panel?). I will not touch it."
    echo "$nginx_conf" > "$DIR/deploy/nginx.generated.conf"
    warn "Add a reverse proxy for $DOMAIN → http://127.0.0.1:$PORT in that server (WebSocket upgrade for /agent/ws, buffering off). Reference config: $DIR/deploy/nginx.generated.conf"
    TLS="none-skip"
  elif [ "$DRY" = 1 ]; then echo "${c_dim}[dry-run] write nginx site for $DOMAIN, nginx -t, reload${c_off}"; else
    echo "$nginx_conf" | as_root tee /etc/nginx/sites-available/iran-camping-hub >/dev/null
    as_root ln -sf /etc/nginx/sites-available/iran-camping-hub /etc/nginx/sites-enabled/iran-camping-hub
    as_root nginx -t && as_root systemctl reload nginx && ok "nginx site enabled for $DOMAIN" || { err "nginx config test failed"; exit 1; }
    if [ "$TLS" != "none" ] && command -v certbot >/dev/null; then
      cb=(certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect)
      [ -n "$EMAIL" ] && cb+=(-m "$EMAIL") || cb+=(--register-unsafely-without-email)
      if as_root "${cb[@]}"; then ok "HTTPS certificate issued for $DOMAIN"; else
        err "Let's Encrypt failed (port 80 must be reachable from the internet and $DOMAIN must point here)."
        warn "The hub still works over HTTP for local tests, but Claude/ChatGPT require HTTPS. Fix the cause, then run:  sudo certbot --nginx -d $DOMAIN"
      fi
    fi
  fi
fi

# ───────────────────────── 10. summary ─────────────────────────
step "Done"
if [ "$DRY" = 0 ]; then
  as_user bash -c "cd '$DIR' && NODE_NO_WARNINGS=1 node dist/cli.js doctor" 2>/dev/null || true
fi
cat <<EOF

Next steps
  1. From a network OUTSIDE Iran open:  ${DOMAIN:+https://$DOMAIN}/healthz   → {"ok":true,...}
  2. Connect Claude / ChatGPT / Gemini:  see $DIR/docs/CONNECT.md   (MCP URL: ${DOMAIN:+https://$DOMAIN}/mcp)
  3. Fill the connectors you use in $DIR/.env (WP_*, WC_*, …) then:  sudo systemctl restart iran-camping-hub
  4. Manage staff:  cd $DIR && node dist/cli.js user add --name sara --role content
  5. PC agent: on your computer set HUB_URL=wss://${DOMAIN:-<domain>}/agent/ws and PC_AGENT_TOKEN = the PC_AGENT_TOKEN value in $ENVF
EOF
