"""Incident severity scoring rubric.

Computes incident priority (P1-P4) deterministically based on factual dimensions:
- tier: service criticality (1, 2, 3)
- scope: blast radius ('all', 'many', 'few', 'single')
- data_loss: whether persistent data was lost or corrupted (True, False)
- workaround: available mitigation ('none', 'partial', 'easy')

Point mapping:
- tier: 1 -> 3, 2 -> 2, 3 -> 1
- scope: 'all' -> 3, 'many' -> 2, 'few' -> 1, 'single' -> 0
- data_loss: True -> 2, False -> 0
- workaround: 'none' -> 2, 'partial' -> 1, 'easy' -> 0

Label thresholds:
- total >= 8: P1
- 6 <= total <= 7: P2
- 3 <= total <= 5: P3
- total <= 2: P4
"""

TIER_POINTS = {
    1: 3,
    2: 2,
    3: 1,
    "1": 3,
    "2": 2,
    "3": 1,
}

SCOPE_POINTS = {
    "all": 3,
    "many": 2,
    "few": 1,
    "single": 0,
}

WORKAROUND_POINTS = {
    "none": 2,
    "partial": 1,
    "easy": 0,
}


def compute_points(tier, scope, data_loss, workaround):
    """Calculate the integer point sum from facts."""
    if tier not in TIER_POINTS:
        raise ValueError(f"Invalid tier: {tier}. Must be 1, 2, or 3.")
    
    scope_key = str(scope).lower().strip()
    if scope_key not in SCOPE_POINTS:
        raise ValueError(f"Invalid scope: {scope}. Must be 'all', 'many', 'few', or 'single'.")
    
    if isinstance(data_loss, str):
        data_loss_bool = data_loss.lower().strip() in ("true", "1", "yes")
    else:
        data_loss_bool = bool(data_loss)
    
    workaround_key = str(workaround).lower().strip()
    if workaround_key not in WORKAROUND_POINTS:
        raise ValueError(f"Invalid workaround: {workaround}. Must be 'none', 'partial', or 'easy'.")
    
    points = (
        TIER_POINTS[tier]
        + SCOPE_POINTS[scope_key]
        + (2 if data_loss_bool else 0)
        + WORKAROUND_POINTS[workaround_key]
    )
    return points


def label_from_facts(tier, scope, data_loss, workaround):
    """Map factual incident dimensions to a priority label (P1, P2, P3, P4)."""
    total = compute_points(tier, scope, data_loss, workaround)
    if total >= 8:
        return "P1"
    elif total >= 6:
        return "P2"
    elif total >= 3:
        return "P3"
    else:
        return "P4"
