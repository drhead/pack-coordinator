from pathlib import Path
from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.templating import Jinja2Templates

router = APIRouter()
templates = Jinja2Templates(directory="templates")
DIST_INDEX = Path("dist/index.html")


@router.get("/", response_class=HTMLResponse)
def index(request: Request):
    """Serves compiled static index.html in production, or Jinja2 template in local dev."""
    if DIST_INDEX.is_file():
        return FileResponse(DIST_INDEX)
    return templates.TemplateResponse("index.html", {"request": request})