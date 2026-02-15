import Foundation

class WebSocketManager: ObservableObject {
    @Published var isConnected = false
    @Published var lastMessage: String?

    private var webSocket: URLSessionWebSocketTask?
    private let session = URLSession.shared
    private let baseURL: String

    init(baseURL: String = "ws://localhost:3000") {
        self.baseURL = baseURL
    }

    func connect() {
        guard let url = URL(string: "\(baseURL)/ws") else { return }

        webSocket = session.webSocketTask(with: url)
        webSocket?.resume()
        isConnected = true
        receiveMessages()
    }

    func disconnect() {
        webSocket?.cancel(with: .normalClosure, reason: nil)
        isConnected = false
    }

    func send(_ message: String) {
        webSocket?.send(.string(message)) { error in
            if let error {
                print("[WebSocket] Send error: \(error)")
            }
        }
    }

    private func receiveMessages() {
        webSocket?.receive { [weak self] result in
            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    DispatchQueue.main.async {
                        self?.lastMessage = text
                    }
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        DispatchQueue.main.async {
                            self?.lastMessage = text
                        }
                    }
                @unknown default:
                    break
                }
                // Continue listening
                self?.receiveMessages()

            case .failure(let error):
                print("[WebSocket] Receive error: \(error)")
                DispatchQueue.main.async {
                    self?.isConnected = false
                }
            }
        }
    }
}
