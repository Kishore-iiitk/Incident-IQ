"""Classifier wrappers and models for Incident-IQ."""

from typing import List
from sklearn.base import BaseEstimator, ClassifierMixin
from sklearn.linear_model import LogisticRegression

CLASSES = ["P1", "P2", "P3", "P4"]


class SentenceTransformerClassifier(BaseEstimator, ClassifierMixin):
    """Pipeline-like classifier combining SentenceTransformer and LogisticRegression."""

    def __init__(
        self,
        model_name: str = "all-MiniLM-L6-v2",
        class_weight: str = "balanced",
        max_iter: int = 2000,
        random_state: int = 42,
    ):
        self.model_name = model_name
        self.class_weight = class_weight
        self.max_iter = max_iter
        self.random_state = random_state
        self.clf = LogisticRegression(
            class_weight=class_weight,
            max_iter=max_iter,
            random_state=random_state,
        )
        self._encoder = None

    def __getstate__(self):
        state = self.__dict__.copy()
        state["_encoder"] = None
        return state

    def __setstate__(self, state):
        self.__dict__.update(state)
        self._encoder = None

    def _get_encoder(self):
        if self._encoder is None:
            from sentence_transformers import SentenceTransformer
            self._encoder = SentenceTransformer(self.model_name)
        return self._encoder

    def fit(self, X: List[str], y: List[str]):
        encoder = self._get_encoder()
        embeddings = encoder.encode(list(X), show_progress_bar=False, convert_to_numpy=True)
        self.clf.fit(embeddings, y)
        self.classes_ = self.clf.classes_
        return self

    def predict(self, X: List[str]):
        encoder = self._get_encoder()
        embeddings = encoder.encode(list(X), show_progress_bar=False, convert_to_numpy=True)
        return self.clf.predict(embeddings)

    def predict_proba(self, X: List[str]):
        encoder = self._get_encoder()
        embeddings = encoder.encode(list(X), show_progress_bar=False, convert_to_numpy=True)
        return self.clf.predict_proba(embeddings)
