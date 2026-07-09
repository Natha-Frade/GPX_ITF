import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from sqlalchemy import text

from .database import engine, Base, SessionLocal
from . import models, auth
from .routers import admin, dados, gopro

# Cria tabelas
Base.metadata.create_all(bind=engine)

# Seed: garante que existe pelo menos 1 admin padrão
def seed_admin():
    from .auth import hash_senha
    db = SessionLocal()
    try:
        if not db.query(models.Usuario).filter_by(is_admin=True).first():
            admin_nome  = os.getenv("ADMIN_NOME",  "admin")
            admin_senha = os.getenv("ADMIN_SENHA", "imtraff2024")
            u = models.Usuario(
                nome=admin_nome,
                senha_hash=hash_senha(admin_senha),
                is_admin=True,
            )
            db.add(u)
            db.commit()
            print(f"[SEED] Admin criado: {admin_nome}")
    finally:
        db.close()

seed_admin()

app = FastAPI(title="GPX IMTRAFF", docs_url="/api/docs")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router,   prefix="/api")
app.include_router(admin.router,  prefix="/api")
app.include_router(dados.router,  prefix="/api")
app.include_router(gopro.router,  prefix="/api")

# ── Serve o frontend estático ─────────────────────────────────────────
STATIC_DIR = os.path.join(os.path.dirname(__file__), "..", "static")

if os.path.isdir(os.path.join(STATIC_DIR, "js")):
    app.mount("/js",  StaticFiles(directory=os.path.join(STATIC_DIR, "js")),  name="js")
if os.path.isdir(os.path.join(STATIC_DIR, "css")):
    app.mount("/css", StaticFiles(directory=os.path.join(STATIC_DIR, "css")), name="css")

@app.get("/logo.png")
def logo():
    return FileResponse(os.path.join(STATIC_DIR, "logo.png"))

@app.get("/favicon.png")
def favicon():
    return FileResponse(os.path.join(STATIC_DIR, "favicon.png"))

@app.get("/admin")
def admin_page():
    f = os.path.join(STATIC_DIR, "admin.html")
    return FileResponse(f)

@app.get("/{full_path:path}")
def frontend(full_path: str):
    # Qualquer rota não-API serve o index.html
    f = os.path.join(STATIC_DIR, "index.html")
    return FileResponse(f)
