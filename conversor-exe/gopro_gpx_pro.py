#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gopro_gpx_pro.py — Conversor GoPro → GPX (versão distribuível / .exe)
─────────────────────────────────────────────────────────────────────
Converte uma PASTA inteira de vídeos GoPro em arquivos .gpx (1 por vídeo),
replicando o formato do goprotelemetryextractor.com (1 ponto/seg).

Diferenciais desta versão:
  • Processamento PARALELO — converte vários vídeos ao mesmo tempo,
    aproveitando os núcleos do processador. Um lote de 60 vídeos que
    levaria minutos em série termina em uma fração do tempo.
  • exiftool EMBUTIDO — quando empacotado com PyInstaller, o exiftool
    vai dentro do .exe. A pessoa só abre e usa; não instala nada.
  • Lembra a última pasta usada (config em %APPDATA%).
  • Resumo do lote ao final e log detalhado por vídeo.

Empacotamento (ver build_exe.bat): o exiftool.exe + pasta exiftool_files
são incluídos via --add-data e localizados em runtime por _caminho_exiftool().
"""

import os
import re
import sys
import json
import queue
import threading
import subprocess
import xml.sax.saxutils as sax
from concurrent.futures import ThreadPoolExecutor, as_completed

import tkinter as tk
from tkinter import ttk, filedialog, messagebox

# ============================================================================
# CONFIG
# ============================================================================
EXTENSOES_VIDEO = (".mp4", ".MP4", ".mov", ".MOV")
CREATOR = "GPX IMTRAFF — GoPro Converter"
APP_NOME = "GoProGPX"

# Nº de conversões simultâneas. Padrão: nº de núcleos, limitado a 6 para não
# saturar o disco (o gargalo do exiftool costuma ser leitura, não CPU).
_CPU = os.cpu_count() or 4
PARALELISMO_PADRAO = max(2, min(6, _CPU))

# Esconde a janela de console do exiftool no Windows
_NOWIN = 0x08000000 if os.name == "nt" else 0


# ============================================================================
# LOCALIZAÇÃO DO EXIFTOOL (embutido no exe OU ao lado do script)
# ============================================================================
def _base_dir():
    """Diretório base: _MEIPASS quando empacotado (PyInstaller), senão a pasta do script."""
    if getattr(sys, "frozen", False):
        return sys._MEIPASS
    return os.path.dirname(os.path.abspath(__file__))


def _caminho_exiftool():
    """
    Procura o exiftool nesta ordem:
      1) embutido no bundle (_MEIPASS/exiftool.exe);
      2) ao lado do executável/script;
      3) variável de ambiente EXIFTOOL_PATH;
      4) 'exiftool' no PATH.
    """
    candidatos = [
        os.path.join(_base_dir(), "exiftool.exe"),
        os.path.join(_base_dir(), "exiftool"),
    ]
    # ao lado do .exe final (quando frozen, sys.executable é o exe)
    if getattr(sys, "frozen", False):
        candidatos.insert(0, os.path.join(os.path.dirname(sys.executable), "exiftool.exe"))
    env = os.getenv("EXIFTOOL_PATH")
    if env:
        candidatos.append(env)
    for c in candidatos:
        if c and os.path.isfile(c):
            return c
    import shutil
    return shutil.which("exiftool") or shutil.which("exiftool.exe") or "exiftool"


EXIFTOOL = _caminho_exiftool()


def _run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, creationflags=_NOWIN)


def checar_exiftool():
    try:
        r = _run([EXIFTOOL, "-ver"])
        return r.stdout.strip() or None
    except (FileNotFoundError, OSError):
        return None


# ============================================================================
# CONFIG PERSISTENTE (lembra última pasta)
# ============================================================================
def _config_path():
    base = os.getenv("APPDATA") or os.path.expanduser("~")
    d = os.path.join(base, APP_NOME)
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, "config.json")


def carregar_config():
    try:
        with open(_config_path(), encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def salvar_config(cfg):
    try:
        with open(_config_path(), "w", encoding="utf-8") as f:
            json.dump(cfg, f)
    except Exception:
        pass


# ============================================================================
# EXTRAÇÃO / GPX
# ============================================================================
def _normalizar_tempo(s):
    if not s:
        return None
    m = re.match(r"^(\d{4}):(\d{2}):(\d{2})\s+(.*)$", s.strip())
    if not m:
        return None
    ano, mes, dia, resto = m.groups()
    resto = resto.strip()
    if not resto.endswith("Z") and "+" not in resto:
        resto += "Z"
    return f"{ano}-{mes}-{dia}T{resto}"


def _segundo_de(t):
    if not t:
        return None
    return re.sub(r"(\d{2}:\d{2}:\d{2})(\.\d+)?", r"\1", t)


def decimar_1hz(pontos):
    saida, ultimo = [], None
    for p in pontos:
        seg = _segundo_de(p["time"])
        if seg is None:
            saida.append(p); continue
        if seg != ultimo:
            q = dict(p); q["time"] = seg
            saida.append(q); ultimo = seg
    return saida


def extrair_pontos(video_path):
    fmt = "$GPSLatitude|$GPSLongitude|$GPSAltitude|$GPSDateTime"
    cmd = [EXIFTOOL, "-ee", "-n", "-p", fmt,
           "-api", "largefilesupport=1", video_path]
    r = _run(cmd)
    pontos = []
    for linha in r.stdout.splitlines():
        if not linha.strip():
            continue
        partes = linha.split("|")
        if len(partes) < 2:
            continue
        try:
            lat = float(partes[0].strip()); lon = float(partes[1].strip())
        except ValueError:
            continue
        if lat == 0.0 and lon == 0.0:
            continue
        ele = None
        if len(partes) > 2 and partes[2].strip():
            try:
                ele = float(re.sub(r"[^\d.\-]", "", partes[2].strip()))
            except ValueError:
                ele = None
        time_s = partes[3].strip() if len(partes) > 3 else ""
        pontos.append({"lat": lat, "lon": lon, "ele": ele,
                       "time": _normalizar_tempo(time_s)})
    return pontos


def ler_modelo(video_path):
    r = _run([EXIFTOOL, "-s3", "-Model", video_path])
    return r.stdout.strip() or "GoPro"


def _fmt(v):
    return repr(float(v))


def montar_gpx(pontos, nome_mp4, modelo):
    esc = sax.escape
    L = ['<?xml version="1.0" encoding="UTF-8"?>',
         '<gpx xmlns="http://www.topografix.com/GPX/1/1"',
         '    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
         '    version="1.1"',
         f'    creator="{esc(CREATOR)}">',
         "    <trk>",
         f"        <name>{esc(nome_mp4)}</name>",
         f"        <src>{esc(modelo)}</src>",
         "        <trkseg>"]
    for p in pontos:
        L.append(f'            <trkpt lat="{_fmt(p["lat"])}" lon="{_fmt(p["lon"])}">')
        if p["ele"] is not None:
            L.append(f"                <ele>{_fmt(p['ele'])}</ele>")
        if p["time"]:
            L.append(f"                <time>{esc(p['time'])}</time>")
        L.append("            </trkpt>")
    L += ["        </trkseg>", "    </trk>", "</gpx>"]
    return "\n".join(L) + "\n"


def listar_videos(pasta, recursivo):
    achados = []
    if recursivo:
        for raiz, _d, arqs in os.walk(pasta):
            for f in arqs:
                if f.endswith(EXTENSOES_VIDEO):
                    achados.append(os.path.join(raiz, f))
    else:
        for f in os.listdir(pasta):
            full = os.path.join(pasta, f)
            if f.endswith(EXTENSOES_VIDEO) and os.path.isfile(full):
                achados.append(full)
    return sorted(achados)


def converter_um(video_path, pasta_saida, pasta_base, um_hz, recursivo, pular):
    """Converte um único vídeo. Retorna dict com resultado (para o log)."""
    nome = os.path.basename(video_path)
    base = os.path.splitext(nome)[0]
    if recursivo:
        destino_dir = os.path.dirname(video_path)
        rotulo = os.path.relpath(video_path, pasta_base)
    else:
        destino_dir = pasta_saida
        rotulo = nome
    os.makedirs(destino_dir, exist_ok=True)
    gpx_path = os.path.join(destino_dir, base + ".gpx")

    if pular and os.path.exists(gpx_path):
        return {"rotulo": rotulo, "status": "pulado", "pontos": 0}

    try:
        pontos = extrair_pontos(video_path)
    except Exception as e:
        return {"rotulo": rotulo, "status": "erro", "erro": str(e), "pontos": 0}

    if not pontos:
        return {"rotulo": rotulo, "status": "sem_gps", "pontos": 0}

    if um_hz:
        pontos = decimar_1hz(pontos)
    modelo = ler_modelo(video_path)
    try:
        with open(gpx_path, "w", encoding="utf-8") as fh:
            fh.write(montar_gpx(pontos, nome, modelo))
    except Exception as e:
        return {"rotulo": rotulo, "status": "erro", "erro": str(e), "pontos": 0}

    return {"rotulo": rotulo, "status": "ok", "pontos": len(pontos)}


# ============================================================================
# WORKER PARALELO
# ============================================================================
def worker(pasta_in, pasta_out, um_hz, recursivo, pular, paralelismo, q, stop_flag):
    try:
        videos = listar_videos(pasta_in, recursivo)
    except Exception as e:
        q.put(("erro", f"Não consegui ler a pasta: {e}")); q.put(("fim", None)); return

    if not videos:
        q.put(("log", "Nenhum vídeo encontrado nessa pasta.")); q.put(("fim", None)); return

    total = len(videos)
    q.put(("total", total))
    q.put(("log", f"{total} vídeo(s) encontrado(s)."))
    q.put(("log", f"Convertendo {paralelismo} por vez (paralelo)  |  "
                  f"{'18 Hz bruto' if not um_hz else '1 Hz (igual ao site)'}\n"))

    ok = sem = erros = pulados = 0
    feitos = 0
    with ThreadPoolExecutor(max_workers=paralelismo) as ex:
        futuros = {
            ex.submit(converter_um, v, pasta_out, pasta_in, um_hz, recursivo, pular): v
            for v in videos
        }
        for fut in as_completed(futuros):
            if stop_flag.is_set():
                q.put(("log", "\n== Cancelando (aguardando vídeos em andamento) =="))
                break
            r = fut.result()
            feitos += 1
            st = r["status"]
            if st == "ok":
                ok += 1
                q.put(("log", f"[{feitos}/{total}] OK  {r['rotulo']}  ({r['pontos']} pts)"))
            elif st == "sem_gps":
                sem += 1
                q.put(("log", f"[{feitos}/{total}] sem GPS  {r['rotulo']}"))
            elif st == "pulado":
                pulados += 1
                q.put(("log", f"[{feitos}/{total}] pulado (já existe)  {r['rotulo']}"))
            else:
                erros += 1
                q.put(("log", f"[{feitos}/{total}] ERRO  {r['rotulo']}  ({r.get('erro','')})"))
            q.put(("prog", feitos))

    q.put(("log", f"\nConcluído: {ok} gerado(s), {sem} sem GPS, "
                  f"{pulados} pulado(s), {erros} erro(s)."))
    q.put(("resumo", (ok, sem, pulados, erros)))
    q.put(("fim", None))


# ============================================================================
# GUI
# ============================================================================
class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Conversor GoPro → GPX")
        self.geometry("760x600")
        self.minsize(680, 520)
        self.configure(bg="#0f1115")

        self.cfg = carregar_config()
        self.q = queue.Queue()
        self.stop_flag = threading.Event()
        self.thread = None

        self._estilo()
        self._ui()
        self.after(100, self._drenar)

    def _estilo(self):
        s = ttk.Style(self)
        try:
            s.theme_use("clam")
        except Exception:
            pass
        bg, fg, ac = "#0f1115", "#e6e6e6", "#73b753"
        s.configure(".", background=bg, foreground=fg, fieldbackground="#1b1e24")
        s.configure("TButton", background="#1b1e24", foreground=fg, padding=8, borderwidth=0)
        s.map("TButton", background=[("active", "#2a2e37")])
        s.configure("Accent.TButton", background=ac, foreground="#0f1115",
                    font=("Segoe UI", 11, "bold"), padding=10)
        s.map("Accent.TButton", background=[("active", "#8fd06a")])
        s.configure("TCheckbutton", background=bg, foreground=fg)
        s.configure("TRadiobutton", background=bg, foreground=fg)
        s.configure("Horizontal.TProgressbar", background=ac, troughcolor="#1b1e24", borderwidth=0)

    def _ui(self):
        pad = {"padx": 14, "pady": 6}
        top = tk.Frame(self, bg="#0f1115"); top.pack(fill="x", **pad)
        tk.Label(top, text="Conversor GoPro → GPX", bg="#0f1115", fg="#73b753",
                 font=("Segoe UI", 17, "bold")).pack(anchor="w")
        tk.Label(top, text="Converte a pasta inteira em GPX — rápido, em paralelo.",
                 bg="#0f1115", fg="#9aa0a8", font=("Segoe UI", 9)).pack(anchor="w")

        fin = tk.Frame(self, bg="#0f1115"); fin.pack(fill="x", **pad)
        tk.Label(fin, text="Pasta dos vídeos:", bg="#0f1115", fg="#e6e6e6",
                 width=15, anchor="w").pack(side="left")
        self.var_in = tk.StringVar(value=self.cfg.get("ultima_pasta", ""))
        tk.Entry(fin, textvariable=self.var_in, bg="#1b1e24", fg="#e6e6e6",
                 insertbackground="#e6e6e6", relief="flat").pack(
                 side="left", fill="x", expand=True, padx=(0, 6), ipady=4)
        ttk.Button(fin, text="Escolher...", command=self._pick_in).pack(side="left")

        fout = tk.Frame(self, bg="#0f1115"); fout.pack(fill="x", **pad)
        tk.Label(fout, text="Pasta de saída:", bg="#0f1115", fg="#e6e6e6",
                 width=15, anchor="w").pack(side="left")
        self.var_out = tk.StringVar(value=self.cfg.get("ultima_saida", ""))
        tk.Entry(fout, textvariable=self.var_out, bg="#1b1e24", fg="#e6e6e6",
                 insertbackground="#e6e6e6", relief="flat").pack(
                 side="left", fill="x", expand=True, padx=(0, 6), ipady=4)
        ttk.Button(fout, text="Escolher...", command=self._pick_out).pack(side="left")
        tk.Label(self, text="   (vazio = subpasta 'gpx' dentro da pasta dos vídeos)",
                 bg="#0f1115", fg="#5c6069", font=("Segoe UI", 8)).pack(anchor="w", padx=14)

        opt = tk.Frame(self, bg="#0f1115"); opt.pack(fill="x", **pad)
        self.var_hz = tk.StringVar(value="1hz")
        ttk.Radiobutton(opt, text="1 ponto/seg (igual ao site)",
                        variable=self.var_hz, value="1hz").pack(side="left", padx=(0, 14))
        ttk.Radiobutton(opt, text="18 Hz (bruto)",
                        variable=self.var_hz, value="hz").pack(side="left")

        opt2 = tk.Frame(self, bg="#0f1115"); opt2.pack(fill="x", **pad)
        self.var_rec = tk.BooleanVar(value=False)
        ttk.Checkbutton(opt2, text="Incluir subpastas", variable=self.var_rec).pack(side="left")
        self.var_skip = tk.BooleanVar(value=True)
        ttk.Checkbutton(opt2, text="Pular GPX já existentes",
                        variable=self.var_skip).pack(side="left", padx=14)
        tk.Label(opt2, text="Simultâneos:", bg="#0f1115", fg="#9aa0a8").pack(side="left", padx=(14, 4))
        self.var_par = tk.IntVar(value=PARALELISMO_PADRAO)
        tk.Spinbox(opt2, from_=1, to=12, width=4, textvariable=self.var_par,
                   bg="#1b1e24", fg="#e6e6e6", relief="flat",
                   buttonbackground="#2a2e37").pack(side="left")

        act = tk.Frame(self, bg="#0f1115"); act.pack(fill="x", **pad)
        self.btn_go = ttk.Button(act, text="CONVERTER TUDO", style="Accent.TButton",
                                 command=self._start)
        self.btn_go.pack(side="left")
        self.btn_stop = ttk.Button(act, text="Cancelar", command=self._cancel, state="disabled")
        self.btn_stop.pack(side="left", padx=8)
        self.btn_open = ttk.Button(act, text="Abrir saída", command=self._abrir, state="disabled")
        self.btn_open.pack(side="left")

        self.prog = ttk.Progressbar(self, mode="determinate", style="Horizontal.TProgressbar")
        self.prog.pack(fill="x", padx=14, pady=(4, 2))
        self.lbl = tk.Label(self, text="", bg="#0f1115", fg="#9aa0a8", font=("Segoe UI", 9))
        self.lbl.pack(anchor="w", padx=14)

        logf = tk.Frame(self, bg="#0f1115"); logf.pack(fill="both", expand=True, **pad)
        self.log = tk.Text(logf, bg="#0a0c0f", fg="#e6e6e6", relief="flat",
                           font=("Consolas", 9), wrap="word")
        self.log.pack(side="left", fill="both", expand=True)
        sb = ttk.Scrollbar(logf, command=self.log.yview); sb.pack(side="right", fill="y")
        self.log.config(yscrollcommand=sb.set, state="disabled")

        ver = checar_exiftool()
        if ver:
            self._log(f"exiftool {ver} pronto (embutido).  Núcleos: {_CPU}.")
        else:
            self._log("AVISO: exiftool não encontrado. Se estiver rodando o .py solto, "
                      "coloque exiftool.exe na mesma pasta. No .exe empacotado ele já vem embutido.")

    def _pick_in(self):
        d = filedialog.askdirectory(title="Pasta com os vídeos GoPro",
                                    initialdir=self.var_in.get() or None)
        if d:
            self.var_in.set(d)

    def _pick_out(self):
        d = filedialog.askdirectory(title="Pasta de saída dos GPX",
                                    initialdir=self.var_out.get() or None)
        if d:
            self.var_out.set(d)

    def _log(self, txt):
        self.log.config(state="normal")
        self.log.insert("end", txt + "\n")
        self.log.see("end")
        self.log.config(state="disabled")

    def _start(self):
        pin = self.var_in.get().strip().strip('"')
        if not pin or not os.path.isdir(pin):
            messagebox.showerror("Pasta inválida", "Escolha uma pasta de vídeos válida.")
            return
        if checar_exiftool() is None:
            messagebox.showerror("exiftool ausente",
                                 "exiftool não encontrado. No .exe empacotado ele vem embutido; "
                                 "rodando o .py, coloque exiftool.exe na mesma pasta.")
            return
        rec = self.var_rec.get()
        pout = self.var_out.get().strip().strip('"') or os.path.join(pin, "gpx")
        self._pout = pin if rec else pout

        # salva config
        self.cfg["ultima_pasta"] = pin
        self.cfg["ultima_saida"] = self.var_out.get().strip()
        salvar_config(self.cfg)

        self.stop_flag.clear()
        self.prog["value"] = 0
        self.btn_go.config(state="disabled")
        self.btn_stop.config(state="normal")
        self.btn_open.config(state="disabled")

        self.thread = threading.Thread(
            target=worker,
            args=(pin, pout, self.var_hz.get() == "1hz", rec, self.var_skip.get(),
                  int(self.var_par.get()), self.q, self.stop_flag),
            daemon=True)
        self.thread.start()

    def _cancel(self):
        self.stop_flag.set()
        self._log("\nCancelando...")

    def _abrir(self):
        p = getattr(self, "_pout", None)
        if p and os.path.isdir(p):
            try:
                os.startfile(p)
            except AttributeError:
                subprocess.Popen(["xdg-open", p])

    def _drenar(self):
        try:
            while True:
                tipo, dado = self.q.get_nowait()
                if tipo == "log":
                    self._log(dado)
                elif tipo == "total":
                    self.prog["maximum"] = dado
                    self.lbl.config(text=f"0 / {dado}")
                elif tipo == "prog":
                    self.prog["value"] = dado
                    self.lbl.config(text=f"{dado} / {int(self.prog['maximum'])}")
                elif tipo == "resumo":
                    ok, sem, pul, err = dado
                    self.lbl.config(text=f"Concluído: {ok} OK, {sem} sem GPS, "
                                         f"{pul} pulados, {err} erros")
                elif tipo == "erro":
                    messagebox.showerror("Erro", dado)
                elif tipo == "fim":
                    self.btn_go.config(state="normal")
                    self.btn_stop.config(state="disabled")
                    self.btn_open.config(state="normal")
        except queue.Empty:
            pass
        self.after(100, self._drenar)


if __name__ == "__main__":
    App().mainloop()
