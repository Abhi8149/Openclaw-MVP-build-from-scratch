# 🌳 Decision Tree in Machine Learning

A comprehensive guide based on the GeeksforGeeks article:  
[Decision Tree Introduction & Example](https://www.geeksforgeeks.org/machine-learning/decision-tree-introduction-example/)

---

## What is a Decision Tree?

A **Decision Tree** is a supervised learning algorithm used for both **classification** and **regression** tasks. It has a hierarchical tree structure consisting of:

- **Root Node** — The topmost node representing the entire dataset.
- **Internal Nodes** — Represent tests on attributes (features).
- **Branches** — Represent the outcome of a test.
- **Leaf Nodes** — Represent the final decision or prediction.

Decision trees are widely used due to their **interpretability**, **flexibility**, and **low preprocessing requirements**.

---

## How Does a Decision Tree Work?

The algorithm splits the dataset recursively based on feature values to create **pure subsets** (where all items in a group belong to the same class).

### Example: Predicting Customer Purchase

| Step | Question | Outcome |
|------|----------|---------|
| 1 | **Income > $50,000?** | If No → "No Purchase". If Yes → go to Step 2 |
| 2 | **Age > 30?** | If No → "No Purchase". If Yes → go to Step 3 |
| 3 | **Previous Purchases > 0?** | If Yes → "Purchase". If No → "No Purchase" |

The tree asks a series of questions, and each answer directs you down a branch until you reach a leaf node with a final decision.

---

## Attribute Selection Measures

The core challenge is deciding **which feature to split on at each node**. Two popular metrics are used:

### 1️⃣ Information Gain (based on Entropy)

**Entropy** measures the impurity or uncertainty in a dataset.

```
Entropy(S) = - Σ pᵢ · log₂(pᵢ)
```

**Information Gain** measures how much uncertainty is reduced by splitting on a feature.

```
Gain(S, A) = Entropy(S) - Σ ( |Sᵥ| / |S| ) · Entropy(Sᵥ)
```

- **Higher Gain** → Better split feature
- The feature with the **maximum Information Gain** is chosen as the root / internal node

### 2️⃣ Gini Index

The Gini Index measures how often a randomly chosen element would be incorrectly identified.

```
Gini = 1 - Σ pᵢ²
```

- **Lower Gini** → Better split (purer subset)
- Used by default in scikit-learn's `DecisionTreeClassifier`
- Faster to compute than entropy

---

## Real-Life Example: Planning Weekend Activities

| Outlook  | Humidity  | Wind    | Activity      |
|----------|-----------|---------|---------------|
| Sunny    | High      | Weak    | Swimming      |
| Sunny    | Normal    | Strong  | Hiking        |
| Cloudy   | High      | Weak    | Hiking        |
| Rainy    | Normal    | Weak    | Stay Inside   |
| Rainy    | High      | Strong  | Stay Inside   |

**Step-by-step tree building:**

1. **Root:** *"What is the Outlook?"*
   - **Sunny** → Ask about Humidity
   - **Cloudy** → Directly "Hiking"
   - **Rainy** → Directly "Stay Inside"

2. **Internal (Sunny branch):** *"Is Humidity High or Normal?"*
   - **High Humidity** → "Swimming"
   - **Normal Humidity** → "Hiking"

---

## Advantages ✅

- Easy to understand and interpret
- Requires little data preprocessing (no scaling/normalization needed)
- Handles both numerical and categorical data
- Mimics human decision-making

## Disadvantages ❌

- Prone to **overfitting** (can be mitigated by pruning)
- Sensitive to small data variations (high variance)
- Can be biased toward features with more levels
- Greedy algorithm may not find the globally optimal tree

---

## When to Use Decision Trees

- You need a **white-box model** (explainable to stakeholders)
- Dataset has **mixed data types**
- You want a **baseline model** before trying ensemble methods
- Feature interactions are important

---

## Sample Code

Check out **[`decision_tree.py`](./decision_tree.py)** in this folder for a from-scratch implementation of a Decision Tree classifier using Information Gain, complete with the weekend activity planning example!