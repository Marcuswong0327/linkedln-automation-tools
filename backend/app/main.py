from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router
from app.config import get_settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # startup code 

    # initialize Qwen Vision Model
    from app.vision.openrouter_vision import get_engine
    get_engine().ensure_client()
    logger.info("LinkedIn Automation Tools with Qwen Vision Model is ready.")

    yield  # app serves requests here

    # shutdown code 
    logger.info("Brain shutting down.")


app = FastAPI(title="LinkedIn Automation Tools", version="1.0.0", lifespan=lifespan)

# In production, need to mention allow_origins like ["https://yourdomain.com"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(router)
