"""AR anchor validation tests against the active Stepwise backend."""

from app.ar.annotations import confirmed_anchor, normalize_box


def test_normalize_box_clips_to_normalized_1000_and_preserves_order():
    assert normalize_box([-20, 40, 1200, 900]) == [0, 40, 1000, 900]
    assert normalize_box([100.9, 200.2, 400.8, 600.4]) == [100, 200, 400, 600]


def test_normalize_box_rejects_malformed_or_degenerate_boxes():
    assert normalize_box(None) is None
    assert normalize_box([1, 2, 3]) is None
    assert normalize_box([400, 200, 400, 600]) is None
    assert normalize_box([500, 700, 100, 200]) is None
    assert normalize_box(["not", "numbers", 1, 2]) is None


def test_only_known_components_and_verified_sources_can_be_confirmed():
    confirmed = confirmed_anchor("spindle", [100, 200, 400, 600])
    assert confirmed is not None
    assert confirmed["anchor"] == {
        "type": "image_bbox",
        "coordinates": [100, 200, 400, 600],
        "coordinate_system": "normalized_1000",
        "source": "user_confirmed",
    }
    assert confirmed_anchor("not-a-component", [100, 200, 400, 600]) is None
    assert confirmed_anchor("spindle", [100, 200, 400, 600], source="model_guess") is None
    assert confirmed_anchor("spindle", [100, 200, 400, 600], source="aruco") is not None
