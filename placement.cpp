#include <iostream>
#include <vector>
#include <stack>
using namespace std;

// Graph class with adjacency list representation
class Graph {
    int vertices;
    vector<vector<int>> adjList;

public:
    Graph(int v) {
        vertices = v;
        adjList.resize(v);
    }

    void addEdge(int u, int v) {
        adjList[u].push_back(v);
        adjList[v].push_back(u); // For undirected graph
    }

    void dfs(int start) {
        vector<bool> visited(vertices, false);
        stack<int> s;

        s.push(start);

        cout << "DFS Traversal starting from node " << start << ": ";

        while (!s.empty()) {
            int current = s.top();
            s.pop();

            if (!visited[current]) {
                cout << current << " ";
                visited[current] = true;

                // Push all unvisited neighbors onto the stack
                for (int i = adjList[current].size() - 1; i >= 0; i--) {
                    int neighbor = adjList[current][i];
                    if (!visited[neighbor]) {
                        s.push(neighbor);
                    }
                }
            }
        }
        cout << endl;
    }
};

int main() {
    int vertices = 6;
    Graph g(vertices);

    // Adding edges to create a sample graph:
    //      0
    //     / \
    //    1   2
    //   / \   \
    //  3   4   5
    g.addEdge(0, 1);
    g.addEdge(0, 2);
    g.addEdge(1, 3);
    g.addEdge(1, 4);
    g.addEdge(2, 5);

    cout << "Graph with " << vertices << " vertices:" << endl;
    cout << "Edges: (0-1), (0-2), (1-3), (1-4), (2-5)" << endl;

    g.dfs(0);

    return 0;
}