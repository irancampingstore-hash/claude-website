import os

import uvicorn

from .app import build_from_env

if __name__ == "__main__":
    uvicorn.run(build_from_env(), host=os.environ.get("IG_BRIDGE_HOST", "127.0.0.1"), port=int(os.environ.get("IG_BRIDGE_PORT", "8791")), log_level="warning")
