import pytest
from ml.rubric import label_from_facts, compute_points


def test_points_and_labels_every_score():
    # Score 1 -> P4 (Tier 3: 1 + single: 0 + data_loss False: 0 + easy: 0 = 1)
    assert compute_points(tier=3, scope="single", data_loss=False, workaround="easy") == 1
    assert label_from_facts(tier=3, scope="single", data_loss=False, workaround="easy") == "P4"

    # Score 2 -> P4 (Tier 2: 2 + single: 0 + data_loss False: 0 + easy: 0 = 2)
    assert compute_points(tier=2, scope="single", data_loss=False, workaround="easy") == 2
    assert label_from_facts(tier=2, scope="single", data_loss=False, workaround="easy") == "P4"

    # Score 3 -> P3 (Boundary <=2 vs >=3)
    # Tier 3: 1 + few: 1 + data_loss False: 0 + partial: 1 = 3
    assert compute_points(tier=3, scope="few", data_loss=False, workaround="partial") == 3
    assert label_from_facts(tier=3, scope="few", data_loss=False, workaround="partial") == "P3"

    # Score 4 -> P3 (Tier 2: 2 + few: 1 + data_loss False: 0 + partial: 1 = 4)
    assert compute_points(tier=2, scope="few", data_loss=False, workaround="partial") == 4
    assert label_from_facts(tier=2, scope="few", data_loss=False, workaround="partial") == "P3"

    # Score 5 -> P3 (Boundary <=5 vs >=6)
    # Tier 2: 2 + many: 2 + data_loss False: 0 + partial: 1 = 5
    assert compute_points(tier=2, scope="many", data_loss=False, workaround="partial") == 5
    assert label_from_facts(tier=2, scope="many", data_loss=False, workaround="partial") == "P3"

    # Score 6 -> P2 (Boundary 5 vs 6)
    # Tier 1: 3 + many: 2 + data_loss False: 0 + partial: 1 = 6
    assert compute_points(tier=1, scope="many", data_loss=False, workaround="partial") == 6
    assert label_from_facts(tier=1, scope="many", data_loss=False, workaround="partial") == "P2"

    # Score 7 -> P2 (Boundary 7 vs 8)
    # Tier 1: 3 + many: 2 + data_loss False: 0 + none: 2 = 7
    assert compute_points(tier=1, scope="many", data_loss=False, workaround="none") == 7
    assert label_from_facts(tier=1, scope="many", data_loss=False, workaround="none") == "P2"

    # Score 8 -> P1 (Boundary 7 vs 8)
    # Tier 1: 3 + all: 3 + data_loss False: 0 + none: 2 = 8
    assert compute_points(tier=1, scope="all", data_loss=False, workaround="none") == 8
    assert label_from_facts(tier=1, scope="all", data_loss=False, workaround="none") == "P1"

    # Score 9 -> P1 (Tier 1: 3 + all: 3 + data_loss True: 2 + partial: 1 = 9)
    assert compute_points(tier=1, scope="all", data_loss=True, workaround="partial") == 9
    assert label_from_facts(tier=1, scope="all", data_loss=True, workaround="partial") == "P1"

    # Score 10 -> P1 (Max possible: 3 + 3 + 2 + 2 = 10)
    assert compute_points(tier=1, scope="all", data_loss=True, workaround="none") == 10
    assert label_from_facts(tier=1, scope="all", data_loss=True, workaround="none") == "P1"


def test_string_types_and_case_insensitivity():
    assert label_from_facts("1", "ALL", "TRUE", "NONE") == "P1"
    assert label_from_facts("2", "Many", "false", "PARTIAL") == "P3"
    assert label_from_facts("3", "Single", False, "EASY") == "P4"


def test_invalid_arguments_raise_value_error():
    with pytest.raises(ValueError, match="Invalid tier"):
        label_from_facts(tier=0, scope="all", data_loss=False, workaround="none")

    with pytest.raises(ValueError, match="Invalid scope"):
        label_from_facts(tier=1, scope="global", data_loss=False, workaround="none")

    with pytest.raises(ValueError, match="Invalid workaround"):
        label_from_facts(tier=1, scope="all", data_loss=False, workaround="impossible")
