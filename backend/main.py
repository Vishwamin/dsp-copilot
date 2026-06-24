"""
DSP Copilot — Backend
FastAPI + ChromaDB RAG + Groq (llama-3.3-70b-versatile) + Schemdraw Circuit Generation
"""

from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path
from typing import AsyncGenerator

from dotenv import load_dotenv
load_dotenv()  # loads backend/.env automatically

from groq import AsyncGroq
import schemdraw
import schemdraw.elements as elm
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from langchain_community.embeddings import HuggingFaceEmbeddings
from langchain_community.vectorstores import Chroma
from pydantic import BaseModel, Field

# ─────────────────────────────────────────────
# LOGGING
# ─────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
)
log = logging.getLogger("dsp-copilot")

# ─────────────────────────────────────────────
# CONSTANTS
# ─────────────────────────────────────────────

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL   = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")
CHROMA_DIR   = Path("db")
GENERATED_DIR = Path("generated")
UPLOADS_DIR   = Path("uploads")

for _dir in (GENERATED_DIR, UPLOADS_DIR):
    _dir.mkdir(parents=True, exist_ok=True)

# ─────────────────────────────────────────────
# EMBEDDINGS & VECTOR STORE
# ─────────────────────────────────────────────

# Model downloads once and is cached locally forever after
log.info("Loading embedding model…")
_embeddings = HuggingFaceEmbeddings(
    model_name="sentence-transformers/all-mpnet-base-v2",
    model_kwargs={"device": "cpu"},
    encode_kwargs={"normalize_embeddings": True},
    # cache_folder keeps model on disk so it never re-downloads
    cache_folder=str(Path.home() / ".cache" / "sentence_transformers"),
)

_db = Chroma(
    persist_directory=str(CHROMA_DIR),
    embedding_function=_embeddings,
)
log.info("ChromaDB ready.")

# ─────────────────────────────────────────────
# FASTAPI APP
# ─────────────────────────────────────────────

app = FastAPI(title="DSP Copilot API", version="2.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/generated", StaticFiles(directory=str(GENERATED_DIR)), name="generated")
app.mount("/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")

# ─────────────────────────────────────────────
# PYDANTIC MODELS
# ─────────────────────────────────────────────

class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=8192)
    messages: list[ChatMessage] = Field(default_factory=list)
    stream: bool = False


class ChatResponse(BaseModel):
    response: str


class CircuitRequest(BaseModel):
    prompt: str = Field(..., min_length=1)


# ─────────────────────────────────────────────
# RAG RETRIEVAL
# ─────────────────────────────────────────────

def _retrieve_context(query: str, k_semantic: int = 8, k_final: int = 3) -> str:
    """Hybrid retrieval: semantic search from ChromaDB + keyword re-ranking."""
    try:
        docs = _db.similarity_search(query, k=k_semantic)
    except Exception as exc:
        log.warning("ChromaDB retrieval failed: %s", exc)
        return ""

    if not docs:
        return ""

    query_tokens = set(re.findall(r"\w+", query.lower()))

    def _score(doc) -> int:
        body = doc.page_content.lower()
        return sum(1 for tok in query_tokens if tok in body)

    ranked = sorted(docs, key=_score, reverse=True)[:k_final]
    return "\n\n---\n\n".join(d.page_content for d in ranked)


# ─────────────────────────────────────────────
# SYSTEM PROMPT BUILDER
# ─────────────────────────────────────────────

_SYSTEM_TEMPLATE = """\
You are DSP Copilot — an elite AI tutor and engineering assistant specialising in:

• Digital Signal Processing (DSP)
• MATLAB & GNU Octave
• LabVIEW
• Embedded Systems (ARM, FPGA, MCU)
• Communication Systems (OFDM, modulation, channel coding)
• Analog & Mixed-Signal Electronics
• Control Systems & Signal Flow Graphs

Personality & style:
— Highly technical yet intuitive; always build from first principles before equations.
— Use vivid analogies (time-domain ↔ musical chords; convolution ↔ sliding window average).
— Format every response in clean Markdown: headings, bullet points, numbered steps, code blocks.
— Always include the relevant equation in LaTeX-style inline math: $H(z) = \\frac{b_0 + b_1 z^{-1}}{1 + a_1 z^{-1}}$.
— For MATLAB/Python code always use fenced code blocks with the language tag.
— Exam-oriented: flag common misconceptions, typical exam traps, and key takeaways.
— Never truncate. Always complete your explanation fully.

{context_section}
"""

def _build_system_prompt(context: str) -> str:
    if context.strip():
        ctx_section = f"RETRIEVED REFERENCE MATERIAL (use this to ground your answer):\n\n{context}"
    else:
        ctx_section = "(No reference material retrieved — answer from internal knowledge.)"
    return _SYSTEM_TEMPLATE.replace("{context_section}", ctx_section)


# ─────────────────────────────────────────────
# GROQ CLIENT (async)
# ─────────────────────────────────────────────

def _get_groq_client() -> AsyncGroq:
    if not GROQ_API_KEY:
        raise HTTPException(
            status_code=503,
            detail="GROQ_API_KEY not set. Add it to your .env file.",
        )
    return AsyncGroq(api_key=GROQ_API_KEY)


async def _groq_chat(messages: list[dict]) -> str:
    client = _get_groq_client()
    try:
        completion = await client.chat.completions.create(
            model=GROQ_MODEL,
            messages=messages,
            temperature=0.3,
            max_tokens=2048,
            stream=False,
        )
        return completion.choices[0].message.content or ""
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Groq error: {exc}")


async def _groq_stream(messages: list[dict]) -> AsyncGenerator[str, None]:
    client = _get_groq_client()
    try:
        stream = await client.chat.completions.create(
            model=GROQ_MODEL,
            messages=messages,
            temperature=0.3,
            max_tokens=2048,
            stream=True,
        )
        async for chunk in stream:
            token = chunk.choices[0].delta.content
            if token:
                yield token
    except Exception as exc:
        yield f"\n\n**[Groq error]** {exc}"


# ─────────────────────────────────────────────
# CIRCUIT GENERATION
# ─────────────────────────────────────────────

def _classify_circuit(prompt: str) -> str:
    p = prompt.lower()
    if any(k in p for k in ("low pass", "lowpass", "lpf")):
        return "lpf"
    if any(k in p for k in ("high pass", "highpass", "hpf")):
        return "hpf"
    if any(k in p for k in ("band pass", "bandpass", "bpf")):
        return "bpf"
    if any(k in p for k in ("notch", "band stop", "bandstop", "bsf")):
        return "notch"
    if "rc" in p:
        return "rc"
    if "rl" in p:
        return "rl"
    if "voltage divider" in p or "divider" in p:
        return "divider"
    return "default"


def _draw_circuit(circuit_type: str) -> schemdraw.Drawing:
    d = schemdraw.Drawing(fontsize=13)

    if circuit_type == "lpf":
        V = d.add(elm.SourceV().up().label("$V_{in}$", loc="left"))
        d.add(elm.Line().right())
        d.add(elm.Resistor().right().label("R = 1 kΩ", loc="top"))
        d.add(elm.Dot())
        d.add(elm.Capacitor().down().label("C = 0.1 µF", loc="right"))
        d.add(elm.Ground())
        d.add(elm.Line().right().length(1.5))
        d.add(elm.Dot().label("$V_{out}$", loc="right"))
        d.add(elm.Line().left().length(1.5))
        d.add(elm.Line().down().toy(V.start))
        d.add(elm.Line().left().tox(V.start))

    elif circuit_type == "hpf":
        V = d.add(elm.SourceV().up().label("$V_{in}$", loc="left"))
        d.add(elm.Line().right())
        d.add(elm.Capacitor().right().label("C = 0.1 µF", loc="top"))
        d.add(elm.Dot())
        d.add(elm.Resistor().down().label("R = 1 kΩ", loc="right"))
        d.add(elm.Ground())
        d.add(elm.Line().right().length(1.5))
        d.add(elm.Dot().label("$V_{out}$", loc="right"))
        d.add(elm.Line().left().length(1.5))
        d.add(elm.Line().down().toy(V.start))
        d.add(elm.Line().left().tox(V.start))

    elif circuit_type == "bpf":
        V = d.add(elm.SourceV().up().label("$V_{in}$", loc="left"))
        d.add(elm.Line().right())
        d.add(elm.Inductor().right().label("L = 10 mH", loc="top"))
        d.add(elm.Capacitor().right().label("C = 100 nF", loc="top"))
        d.add(elm.Dot())
        d.add(elm.Resistor().down().label("R = 1 kΩ", loc="right"))
        d.add(elm.Ground())
        d.add(elm.Line().right().length(1.5))
        d.add(elm.Dot().label("$V_{out}$", loc="right"))
        d.add(elm.Line().left().length(1.5))
        d.add(elm.Line().down().toy(V.start))
        d.add(elm.Line().left().tox(V.start))

    elif circuit_type == "notch":
        V = d.add(elm.SourceV().up().label("$V_{in}$", loc="left"))
        d.add(elm.Line().right())
        d.add(elm.Resistor().right().label("R", loc="top"))
        d.add(elm.Resistor().right().label("R", loc="top"))
        d.add(elm.Dot().label("$V_{out}$", loc="right"))
        d.add(elm.Capacitor().down().label("2C", loc="right"))
        d.add(elm.Ground())
        d.add(elm.Line().down().toy(V.start))
        d.add(elm.Line().left().tox(V.start))

    elif circuit_type == "rc":
        V = d.add(elm.SourceV().up().label("$V_{in}$", loc="left"))
        d.add(elm.Line().right())
        d.add(elm.Resistor().right().label("R", loc="top"))
        d.add(elm.Capacitor().down().label("C", loc="right"))
        d.add(elm.Ground())
        d.add(elm.Line().down().toy(V.start))
        d.add(elm.Line().left().tox(V.start))

    elif circuit_type == "rl":
        V = d.add(elm.SourceV().up().label("$V_{in}$", loc="left"))
        d.add(elm.Line().right())
        d.add(elm.Resistor().right().label("R", loc="top"))
        d.add(elm.Inductor().down().label("L", loc="right"))
        d.add(elm.Ground())
        d.add(elm.Line().down().toy(V.start))
        d.add(elm.Line().left().tox(V.start))

    elif circuit_type == "divider":
        V = d.add(elm.SourceV().up().label("$V_{in}$", loc="left"))
        d.add(elm.Line().right())
        d.add(elm.Resistor().down().label("R₁ = 1 kΩ", loc="right"))
        d.add(elm.Dot().label("$V_{out}$", loc="right"))
        d.add(elm.Resistor().down().label("R₂ = 2 kΩ", loc="right"))
        d.add(elm.Ground())
        d.add(elm.Line().down().toy(V.start))
        d.add(elm.Line().left().tox(V.start))

    else:
        V = d.add(elm.SourceV().up().label("$V_{in}$", loc="left"))
        d.add(elm.Line().right())
        d.add(elm.Resistor().right().label("R = 1 kΩ", loc="top"))
        d.add(elm.Inductor().right().label("L = 10 mH", loc="top"))
        d.add(elm.Capacitor().down().label("C = 0.1 µF", loc="right"))
        d.add(elm.Ground())
        d.add(elm.Line().down().toy(V.start))
        d.add(elm.Line().left().tox(V.start))

    return d


# ─────────────────────────────────────────────
# ROUTES
# ─────────────────────────────────────────────

@app.get("/")
async def health():
    return {"status": "ok", "model": GROQ_MODEL}


@app.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    context = _retrieve_context(request.prompt)
    system = _build_system_prompt(context)

    messages: list[dict] = [{"role": "system", "content": system}]
    for m in request.messages:
        messages.append({"role": m.role, "content": m.content})
    messages.append({"role": "user", "content": request.prompt})

    log.info("Chat | prompt=%r | ctx_chars=%d", request.prompt[:60], len(context))

    response = await _groq_chat(messages)
    return ChatResponse(response=response)


@app.post("/chat/stream")
async def chat_stream(request: ChatRequest):
    """Server-Sent Events streaming endpoint."""
    context = _retrieve_context(request.prompt)
    system = _build_system_prompt(context)

    messages: list[dict] = [{"role": "system", "content": system}]
    for m in request.messages:
        messages.append({"role": m.role, "content": m.content})
    messages.append({"role": "user", "content": request.prompt})

    log.info("Chat(stream) | prompt=%r | ctx_chars=%d", request.prompt[:60], len(context))

    async def _event_stream():
        async for token in _groq_stream(messages):
            # Escape newlines so each SSE "data:" line stays on one line
            safe_token = token.replace("\n", "\\n")
            yield f"data: {safe_token}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        _event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/generate-circuit")
async def generate_circuit(request: CircuitRequest):
    circuit_type = _classify_circuit(request.prompt)
    log.info("Circuit | type=%s | prompt=%r", circuit_type, request.prompt[:60])

    try:
        drawing = _draw_circuit(circuit_type)
        out_path = GENERATED_DIR / f"circuit_{circuit_type}.png"
        drawing.save(str(out_path), dpi=150)
    except Exception as exc:
        log.exception("Circuit generation failed")
        raise HTTPException(status_code=500, detail=f"Circuit generation error: {exc}")

    return FileResponse(
        str(out_path),
        media_type="image/png",
        headers={"Cache-Control": "no-store"},
    )


@app.post("/upload-image")
async def upload_image(file: UploadFile = File(...)):
    allowed = {"image/png", "image/jpeg", "image/webp", "image/gif"}
    if file.content_type not in allowed:
        raise HTTPException(status_code=400, detail="Unsupported image type.")

    dest = UPLOADS_DIR / (file.filename or "upload.png")
    data = await file.read()
    dest.write_bytes(data)
    log.info("Upload | file=%s | bytes=%d", dest.name, len(data))

    return {"filename": dest.name, "url": f"/uploads/{dest.name}"}