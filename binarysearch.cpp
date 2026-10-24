#include <iostream>
#include <vector>
#include <algorithm>

/**
 * Binary Search - finds the index of a target element in a sorted array/vector.
 * Returns the index if found, -1 otherwise.
 *
 * Time Complexity: O(log n)
 * Space Complexity: O(1)
 */

// Iterative binary search
int binarySearchIterative(const std::vector<int>& arr, int target) {
    int left = 0;
    int right = static_cast<int>(arr.size()) - 1;

    while (left <= right) {
        int mid = left + (right - left) / 2;  // avoids potential overflow

        if (arr[mid] == target)
            return mid;
        else if (arr[mid] < target)
            left = mid + 1;
        else
            right = mid - 1;
    }
    return -1;
}

// Recursive binary search
int binarySearchRecursive(const std::vector<int>& arr, int target, int left, int right) {
    if (left > right)
        return -1;

    int mid = left + (right - left) / 2;

    if (arr[mid] == target)
        return mid;
    else if (arr[mid] < target)
        return binarySearchRecursive(arr, target, mid + 1, right);
    else
        return binarySearchRecursive(arr, target, left, mid - 1);
}

// Wrapper for the recursive version
int binarySearchRecursive(const std::vector<int>& arr, int target) {
    return binarySearchRecursive(arr, target, 0, static_cast<int>(arr.size()) - 1);
}

int main() {
    // Example usage
    std::vector<int> arr = {2, 5, 8, 12, 16, 23, 38, 45, 56, 72};

    // Ensure the array is sorted
    std::sort(arr.begin(), arr.end());

    std::cout << "Array: ";
    for (int val : arr)
        std::cout << val << " ";
    std::cout << "\n\n";

    int targets[] = {23, 5, 99};

    for (int target : targets) {
        int idxIter = binarySearchIterative(arr, target);
        int idxRecur = binarySearchRecursive(arr, target);

        std::cout << "Searching for " << target << ":\n";
        if (idxIter != -1)
            std::cout << "  Iterative: Found at index " << idxIter << "\n";
        else
            std::cout << "  Iterative: Not found\n";

        if (idxRecur != -1)
            std::cout << "  Recursive: Found at index " << idxRecur << "\n";
        else
            std::cout << "  Recursive: Not found\n";
        std::cout << "\n";
    }

    return 0;
}