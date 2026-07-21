import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from sqlalchemy import text
from validacao.router import router as validacao_router
from .database import engine, Base, SessionLocal
from . import models, auth
from .routers import admin, dados, gopro, sharepoint, sharepoint_media

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
app.include_router(sharepoint.router, prefix="/api")
app.include_router(sharepoint_media.router, prefix="/api")
app.include_router(validacao_router)
# ── Serve o frontend estático ─────────────────────────────────────────
STATIC_DIR = os.path.join(os.path.dirname(__file__), "..", "static")

if os.path.isdir(os.path.join(STATIC_DIR, "js")):
    app.mount("/js",  StaticFiles(directory=os.path.join(STATIC_DIR, "js")),  name="js")
if os.path.isdir(os.path.join(STATIC_DIR, "css")):
    app.mount("/css", StaticFiles(directory=os.path.join(STATIC_DIR, "css")), name="css")

# Editor de vídeo (build do Vite em static/editor). html=True faz o /editor/
# servir o index.html do SPA. Precisa vir ANTES do catch-all lá embaixo.
EDITOR_DIR = os.path.join(STATIC_DIR, "editor")
if os.path.isdir(EDITOR_DIR):
    app.mount("/editor", StaticFiles(directory=EDITOR_DIR, html=True), name="editor")

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
    # 1) Se o caminho corresponde a um arquivo real dentro de static/
    #    (ex.: editor.html), serve o próprio arquivo.
    #    abspath + startswith impede path traversal (../../etc/passwd).
    if full_path:
        static_abs = os.path.abspath(STATIC_DIR)
        candidate  = os.path.abspath(os.path.join(static_abs, full_path))
        if candidate.startswith(static_abs + os.sep) and os.path.isfile(candidate):
            return FileResponse(candidate)
    # 2) Senão, comportamento SPA: qualquer rota serve o index.html
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))
