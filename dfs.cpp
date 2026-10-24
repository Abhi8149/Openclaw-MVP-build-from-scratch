#include <iostream>
#include <vector>
using namespace std;

void dfs(int node, vector<bool>& visited, const vector<vector<int>>& adj) {
    visited[node] = true;
    cout << node << " ";

    for (int neighbor : adj[node]) {
        if (!visited[neighbor]) {
            dfs(neighbor, visited, adj);
        }
    }
}

int main() {
    int n = 6;
    vector<vector<int>> adj(n);

    // Example graph
    adj[0] = {1, 2};
    adj[1] = {0, 3, 4};
    adj[2] = {0, 4};
    adj[3] = {1, 5};
    adj[4] = {1, 2, 5};
    adj[5] = {3, 4};

    vector<bool> visited(n, false);

    cout << "DFS Traversal: ";
    dfs(0, visited, adj);
    cout << endl;

    return 0;
}