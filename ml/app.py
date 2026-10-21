"""FastAPI inference and health service for Incident-IQ ML.

Endpoints:
- GET /health: returns real state (best model loaded yes/no, embedding provider name or null, model name, validation macro-F1)
- POST /embed: returns embeddings, responds 503 if no embedding provider is available
- POST /classify: returns predicted label with class probabilities, responds 503 if no model loaded
"""

import os
import sys
import json
import joblib
from typing import Optional, List, Union, Dict
from fastapi import FastAPI, HTTPException, status
from pydantic import BaseModel, Field

# Ensure project root is in sys.path
ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

# Import the classifier wrapper so joblib can unpickle it
from ml.classifier import SentenceTransformerClassifier, CLASSES

app = FastAPI(
    title="Incident-IQ ML Service",
    description="Severity classification and sentence embedding inference API",
    version="1.0.0",
)

# App state containers
app.state.model = None
app.state.model_name = None
app.state.validation_macro_f1 = None
app.state.embedding_model = None
app.state.embedding_provider = None


def load_resources():
    """Load model and embedding provider from disk."""
    models_dir = os.path.join(ROOT_DIR, "ml", "models")
    best_model_path = os.path.join(models_dir, "best_model.joblib")
    meta_path = os.path.join(models_dir, "model_metadata.json")

    # Load metadata if exists
    if os.path.exists(meta_path):
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
                app.state.model_name = meta.get("best_model_name")
                app.state.validation_macro_f1 = meta.get("validation_macro_f1")
                app.state.embedding_provider = meta.get("embedding_provider")
        except Exception as e:
            print(f"Error reading model metadata: {e}", file=sys.stderr)

    # Load best model if exists
    if os.path.exists(best_model_path):
        try:
            app.state.model = joblib.load(best_model_path)
            if hasattr(app.state.model, "clf") and not hasattr(app.state.model.clf, "multi_class"):
                app.state.model.clf.multi_class = "auto"
            if not app.state.model_name:
                app.state.model_name = "best_model"
        except Exception as e:
            print(f"Error loading best_model.joblib: {e}", file=sys.stderr)
            app.state.model = None

    # Load embedding model if sentence_transformers is available
    try:
        from sentence_transformers import SentenceTransformer
        app.state.embedding_model = SentenceTransformer("all-MiniLM-L6-v2")
        app.state.embedding_provider = "sentence-transformers/all-MiniLM-L6-v2"
    except Exception as e:
        print(f"Could not initialize embedding provider: {e}", file=sys.stderr)
        app.state.embedding_model = None
        # Only clear embedding_provider if not set by metadata
        if not app.state.embedding_model:
            app.state.embedding_provider = None


import contextlib

# Safeguard unpickling if model was pickled with __main__
import __main__
setattr(__main__, "SentenceTransformerClassifier", SentenceTransformerClassifier)


@contextlib.asynccontextmanager
async def lifespan(fastapi_app: FastAPI):
    load_resources()
    yield


app.router.lifespan_context = lifespan


# Request / Response Schemas
class HealthResponse(BaseModel):
    status: str
    model_loaded: bool
    model_name: Optional[str] = None
    validation_macro_f1: Optional[float] = None
    embedding_provider: Optional[str] = None


class EmbedRequest(BaseModel):
    text: Optional[str] = None
    texts: Optional[List[str]] = None


class EmbedResponse(BaseModel):
    embedding: Optional[List[float]] = None
    embeddings: Optional[List[List[float]]] = None
    dimensions: int
    provider: str


class ClassifyRequest(BaseModel):
    title: Optional[str] = ""
    description: Optional[str] = ""
    text: Optional[str] = None


class ClassifyResponse(BaseModel):
    predicted_label: str
    probabilities: Dict[str, float]


@app.get("/health", response_model=HealthResponse)
def health():
    return HealthResponse(
        status="ok",
        model_loaded=(app.state.model is not None),
        model_name=app.state.model_name if app.state.model is not None else None,
        validation_macro_f1=app.state.validation_macro_f1 if app.state.model is not None else None,
        embedding_provider=app.state.embedding_provider if app.state.embedding_model is not None else None,
    )


@app.post("/embed", response_model=EmbedResponse)
def embed(req: EmbedRequest):
    if app.state.embedding_model is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Embedding provider is unavailable",
        )

    if req.texts is not None and len(req.texts) > 0:
        raw_embeddings = app.state.embedding_model.encode(req.texts, convert_to_numpy=True)
        embeddings_list = [[float(v) for v in row] for row in raw_embeddings]
        dims = len(embeddings_list[0]) if embeddings_list else 0
        return EmbedResponse(
            embeddings=embeddings_list,
            embedding=embeddings_list[0] if embeddings_list else None,
            dimensions=dims,
            provider=app.state.embedding_provider or "unknown",
        )

    if req.text is not None:
        emb = app.state.embedding_model.encode([req.text], convert_to_numpy=True)[0]
        emb_list = [float(v) for v in emb]
        return EmbedResponse(
            embedding=emb_list,
            embeddings=[emb_list],
            dimensions=len(emb_list),
            provider=app.state.embedding_provider or "unknown",
        )

    raise HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail="Must provide either 'text' or 'texts'",
    )


@app.post("/classify", response_model=ClassifyResponse)
def classify(req: ClassifyRequest):
    if app.state.model is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Classification model is not loaded",
        )

    if req.text is not None and req.text.strip():
        input_text = req.text.strip()
    else:
        title = (req.title or "").strip()
        desc = (req.description or "").strip()
        input_text = f"{title} {desc}".strip()

    if not input_text:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Input text (or title/description) cannot be empty",
        )

    # Model inference
    model = app.state.model
    pred = model.predict([input_text])[0]

    probabilities: Dict[str, float] = {}
    if hasattr(model, "predict_proba"):
        probs = model.predict_proba([input_text])[0]
        classes = getattr(model, "classes_", CLASSES)
        for cls_name, prob in zip(classes, probs):
            probabilities[str(cls_name)] = round(float(prob), 4)
    else:
        for cls_name in CLASSES:
            probabilities[cls_name] = 1.0 if cls_name == pred else 0.0

    return ClassifyResponse(
        predicted_label=str(pred),
        probabilities=probabilities,
    )
