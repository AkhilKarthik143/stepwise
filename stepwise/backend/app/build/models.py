"""Data shapes shared by ingestion, the live step check and the guide.

The same pydantic models are the structured-output schemas sent to Claude, so what the model
returns is validated before anything reads it.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class Part(BaseModel):
    name: str  # "brick 2x4", "long bolt", "dowel"
    color: str = ""
    qty: int = 1

    def spoken(self) -> str:
        words = " ".join(w for w in (self.color, self.name) if w)
        return f"{self.qty} {words}" if self.qty != 1 else f"the {words}"


class Crop(BaseModel):
    """Step picture on its page, in 0-1000 coordinates of the page image."""

    x0: int
    y0: int
    x1: int
    y1: int


class BuildStep(BaseModel):
    step: int
    page: int
    parts: list[Part] = Field(default_factory=list)
    action: str
    expected_image: str  # path relative to the build folder, e.g. "steps/09.png"
    watch_for: list[str] = Field(default_factory=list)
    crop: Crop | None = None
    approved: bool = False  # a person checked this step against the manual


class Source(BaseModel):
    title: str
    url: str = ""


class Build(BaseModel):
    build_id: str
    title: str
    aliases: list[str] = Field(default_factory=list)
    source: Source | None = None
    steps: list[BuildStep]


# ── Claude structured outputs ─────────────────────────────────────────────────
class ExtractedStep(BaseModel):
    step: int
    parts: list[Part]
    action: str
    watch_for: list[str]
    crop: Crop


class PageExtraction(BaseModel):
    steps: list[ExtractedStep]


class CheckIssue(BaseModel):
    part: str
    problem: str
    fix: str


class CheckResult(BaseModel):
    step_complete: bool
    confidence: float
    issues: list[CheckIssue]


class PartMatch(BaseModel):
    is_right_part: bool
    confidence: float
    held_part: str  # what the model thinks is being held up
    say: str  # one short sentence for the technician
