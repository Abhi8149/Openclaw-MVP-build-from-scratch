"""
Decision Tree — From-Scratch Implementation
----------------------------------------------
A pure Python implementation of a Decision Tree classifier
using Information Gain as the splitting criterion.

Reference:
    https://www.geeksforgeeks.org/machine-learning/decision-tree-introduction-example/
"""

from __future__ import annotations

import math
from collections import Counter
from typing import Any, Dict, List, Optional, Set, Tuple


# --------------------------------------------------------------------------- #
#  1.  Utility — Entropy & Information Gain
# --------------------------------------------------------------------------- #

def entropy(labels: List[Any]) -> float:
    """Compute Shannon entropy of a list of class labels."""
    total = len(labels)
    if total == 0:
        return 0.0
    counts = Counter(labels)
    return -sum((c / total) * math.log2(c / total) for c in counts.values())


def information_gain(
    parent_labels: List[Any],
    splits: List[Tuple[Any, List[Any]]],
) -> float:
    """Weighted reduction in entropy after a split."""
    parent_ent = entropy(parent_labels)
    n = len(parent_labels)
    weighted = 0.0
    for _, child_labels in splits:
        if not child_labels:
            continue
        weighted += (len(child_labels) / n) * entropy(child_labels)
    return round(parent_ent - weighted, 4)


# --------------------------------------------------------------------------- #
#  2.  Decision Tree Node & Tree Structure
# --------------------------------------------------------------------------- #

class _Node:    """Represents a single node in the decision tree."""

    def __init__(self) -> None:
        self.feature: Optional[str] = None          # column name to split on
        self.threshold: Optional[Any] = None        # split value (categorical or numeric)
        self.children: Dict[Any, "_Node"] = {}       # branch value → child node
        self.label: Optional[Any] = None             # prediction (leaf only)
        self.gain: float = 0.0                        # information gain of this split


class DecisionTree:    """
    A simple decision tree classifier for categorical features.
    
    Parameters:    
    ----------
    min_samples_split : int
        Minimum number of samples required to split an internal node.
    max_depth : int or None
        Maximum depth of the tree.  None ⇒ grow until pure or no features left.
    """

    def __init__(
        self,
        min_samples_split: int = 2,
        max_depth: Optional[int] = None,
    ) -> None:
        self.min_samples_split = min_samples_split
        self.max_depth = max_depth
        self.tree: Optional[_Node] = None
        self.features: List[str] = []

    # ── Public API ──────────────────────────────────────────────────────

    def fit(
        self,
        X: List[Dict[str, Any]],
        y: List[Any],
        feature_names: Optional[List[str]] = None,
    ) -> "DecisionTree":
        """Build the decision tree from training data."""
        if not X:
            raise ValueError("Empty training set")

        self.features = feature_names or list(X[0].keys())
        self.tree = self._build(X, y, depth=0, used_features=set())
        return self

    def predict(self, X: List[Dict[str, Any]]) -> List[Any]:
        """Return predicted class for each row in X."""
        if self.tree is None:
            raise RuntimeError("Call .fit() before .predict()")
        return [self._traverse(row, self.tree) for row in X]

    def print_tree(self, node: Optional[_Node] = None, indent: int = 0) -> None:
        """Pretty-print the learned decision tree."""
        if node is None:
            node = self.tree
        if node is None:
            print("(empty tree)")
            return

        prefix = "  " * indent
        if node.label is not None:                # leaf
            print(f"{prefix}⟹ Predict: {node.label}")
        else:                                   # internal
            feat_name = node.feature if node.feature else "?"
            print(f"{prefix}[{feat_name}] (Gain={node.gain})")
            for val, child in node.children.items():
                print(f"{prefix}  ├─ {val}:")
                self.print_tree(child, indent + 2)

    # ── Private helpers ─────────────────────────────────────────────────

    def _build(
        self,
        X: List[Dict[str, Any]],
        y: List[Any],
        depth: int,
        used_features: Set[str],
    ) -> _Node:
        node = _Node()

        # Stop criteria
        if len(set(y)) == 1:                     # pure node
            node.label = y[0]
            return node
        if len(X) < self.min_samples_split:         # too few samples
            node.label = Counter(y).most_common(1)[0][0]
            return node
        if self.max_depth is not None and depth >= self.max_depth:
            node.label = Counter(y).most_common(1)[0][0]
            return node

        # Find best feature to split on
        best_feature: Optional[str] = None
        best_gain = -1.0
        best_splits: List[Tuple[Any, List[Any], List[Dict[str, Any]]]] = []

        for feat in self.features:
            if feat in used_features:
                continue

            # Build splits per unique value of *feat*
            splits: Dict[Any, Tuple[List[Dict[str, Any]], List[Any]]] = {}
            for row, label in zip(X, y):
                val = row[feat]
                if val not in splits:
                    splits[val] = ([], [])
                splits[val][0].append(row)    # X subset
                splits[val][1].append(label)  # y subset

            child_labels = [labels for _, labels in splits.values()]
            gain = information_gain(y, [("", lbls) for lbls in child_labels])

            if gain > best_gain:
                best_gain = gain
                best_feature = feat
                best_splits = [(v, x_sub, y_sub) for v, (x_sub, y_sub) in splits.items()]

        # If no useful split found, return leaf
        if best_feature is None or best_gain <= 0:
            node.label = Counter(y).most_common(1)[0][0]
            return node

        node.feature = best_feature
        node.gain = round(best_gain, 4)
        used_features.add(best_feature)

        for val, x_sub, y_sub in best_splits:
            child = self._build(x_sub, y_sub, depth + 1, used_features.copy())
            node.children[val] = child

        return node

    def _traverse(
        self,
        row: Dict[str, Any],
        node: _Node,
    ) -> Any:
        """Recursively walk the tree with a single row."""
        if node.label is not None:
            return node.label

        val = row.get(node.feature)
        child = node.children.get(val)
        if child is None:
            # Unknown branch → fallback to most common label among children
            labels = []
            for c in node.children.values():
                if c.label is not None:
                    labels.append(c.label)
            return Counter(labels).most_common(1)[0][0] if labels else None

        return self._traverse(row, child)


# --------------------------------------------------------------------------- #
#  3.  Demo —  Weekend Activity Planner
# --------------------------------------------------------------------------- #

def run_demo() -> None:
    """Run the weekend-activity example from the GeeksforGeeks article."""

    # Data:  [Outlook, Humidity, Wind] → Activity
    data = [
        {"Outlook": "Sunny",   "Humidity": "High",   "Wind": "Weak"},   # → Swmming
        {"Outlook": "Sunny",    "Humidity": "Normal", "Wind": "Strong"},  # → Hiking
        {"Outlook": "Cloudy",   "Humidity": "High",   "Wind": "Weak"},    # → Hiking
        {"Outlook": "Rainy",    "Humidity": "Normal", "Wind": "Weak"},   # → Stay Inside
        {"Outlook": "Rainy",    "Humidity": "High",   "Wind": "Strong"},  # → Stay Inside
        {"Outlook": "Cloudy",   "Humidity": "Normal", "Wind": "Strong"},  # → Hiking
        {"Outlook": "Sunny",    "Humidity": "High",   "Wind": "Strong"},  # → Swimming
        {"Outlook": "Sunny",   "Humidity": "Normal", "Wind": "Weak"},    # → Hiking
    ]

    labels = [
        "Swimming",
        "Hiking",
        "Hiking",
        "Stay Inside",
        "Stay Inside",
        "Hiking",
        "Swimming",
        "Hiking",
    ]

    feature_names = ["Outlook", "Humidity", "Wind"]

    # Train the tree
    clf = DecisionTree(min_samples_split=2, max_depth=3)
    clf.fit(data, labels, feature_names)

    # Display the learned tree
    print("=" * 55)
    print("  🌳  DECISION TREE — Weeknd Activity Planner")
    print("=" * 55)
    print()
    clf.print_tree()
    print()

    # --- Make predictions ------------------------------------------------
    new_cases = [
        {"Outlook": "Sunny",   "Humidity": "High",    "Wind": "Weak"},
        {"Outlook": "Rainy",    "Humidity": "Normal",   "Wind": "Strong"},
        {"Outlook": "Cloudy",   "Humidity": "High",    "Wind": "Weak"},
    ]

    print("-" * 55)
    print("  📊  Predictions for new cases")
    print("-" * 55)
    predictions = clf.predict(new_cases)
    for case, pred in zip(new_cases, predictions):
        outlook = case["Outlook"]
        humid = case["Humidity"]
        wind = case["Wind"]
        print(f"   {outlook:8} │ {humid:6} │ {wind:6}  → {pred}")
    print()

    # --- Evaluate accuracy on training set --------------------------------
    train_preds = clf.predict(data)
    correct = sum(1 for t, p in zip(labels, train_preds) if t == p)
    acc = correct / len(labels) * 100
    print(f"  ✅  Training accuracy: {correct}/{len(labels)} ({acc:.1f}%)")
    print("=" * 55)


if __name__ == "__main__":
    run_demo()