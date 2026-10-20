"""Build knowledge base vector index.

Embeds title + " " + symptoms for each incident with all-MiniLM-L6-v2.
Outputs server/rag/kb_index.json containing for each incident:
all original fields plus "embedding", and at the top level:
provider name, model name, and dimension (384).
"""

import argparse
import json
import os
import sys

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

from sentence_transformers import SentenceTransformer

from ml.tools.validate_kb import validate_kb


def build_kb_index(
    kb_path: str,
    output_path: str,
    model_name: str = "all-MiniLM-L6-v2",
) -> dict:
    """Validate KB file, generate embeddings for title + symptoms, and save index."""
    print(f"[BuildIndex] Validating KB file at {kb_path}...")
    validate_kb(kb_path)
    print(f"[BuildIndex] KB validation passed.")

    with open(kb_path, "r", encoding="utf-8") as f:
        incidents = json.load(f)

    print(f"[BuildIndex] Loading SentenceTransformer model '{model_name}'...")
    model = SentenceTransformer(model_name)
    dimension = model.get_sentence_embedding_dimension()
    provider_name = f"sentence-transformers/{model_name}"

    # Embed title + " " + symptoms for each incident (do not embed root_cause or resolution)
    texts_to_embed = [f"{item['title']} {item['symptoms']}" for item in incidents]
    print(f"[BuildIndex] Embedding {len(texts_to_embed)} incidents (title + symptoms)...")
    raw_embeddings = model.encode(texts_to_embed, convert_to_numpy=True)

    indexed_incidents = []
    for item, emb in zip(incidents, raw_embeddings):
        entry = dict(item)
        entry["embedding"] = [float(val) for val in emb]
        indexed_incidents.append(entry)

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)

    index_payload = {
        "provider": provider_name,
        "model_name": model_name,
        "model": model_name,
        "dimension": dimension,
        "count": len(indexed_incidents),
        "incidents": indexed_incidents,
    }

    print(f"[BuildIndex] Writing index to {output_path}...")
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(index_payload, f, indent=2)

    file_size_kb = os.path.getsize(output_path) / 1024
    print(
        f"[BuildIndex] Successfully saved {len(indexed_incidents)} indexed incidents "
        f"({dimension}-dim embeddings, {file_size_kb:.1f} KB) to {output_path}"
    )

    return index_payload


def main():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
    default_kb = os.path.join(root, "ml", "data", "chat_outputs", "kb", "kb_batch_01.json")
    default_out = os.path.join(root, "server", "rag", "kb_index.json")

    parser = argparse.ArgumentParser(description="Build Knowledge Base vector index")
    parser.add_argument("--kb-path", default=default_kb, help="Path to input KB JSON file")
    parser.add_argument("--output-path", default=default_out, help="Path to output kb_index.json")
    parser.add_argument("--model", default="all-MiniLM-L6-v2", help="SentenceTransformer model name")

    args = parser.parse_args()

    try:
        build_kb_index(args.kb_path, args.output_path, model_name=args.model)
    except Exception as exc:
        print(f"[BuildIndex] FAILED: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
