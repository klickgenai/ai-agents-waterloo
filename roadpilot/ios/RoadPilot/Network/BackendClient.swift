import Foundation

class BackendClient: ObservableObject {
    static let shared = BackendClient()

    private let baseURL: String
    private let session: URLSession

    init(baseURL: String = "http://localhost:3000") {
        self.baseURL = baseURL
        self.session = URLSession.shared
    }

    // MARK: - Chat

    struct ChatResponse: Codable {
        let text: String
        let threadId: String?
        let toolCalls: [ToolCall]?

        struct ToolCall: Codable {
            let tool: String
            let result: AnyCodable
        }
    }

    func sendMessage(_ message: String, driverId: String?, threadId: String?) async throws -> ChatResponse {
        var body: [String: Any] = ["message": message]
        if let driverId { body["driverId"] = driverId }
        if let threadId { body["threadId"] = threadId }

        return try await post("/api/chat", body: body)
    }

    // MARK: - Tools

    func searchLoads(
        originCity: String,
        originState: String?,
        destinationCity: String,
        destinationState: String?,
        minRatePerMile: Double?,
        equipmentType: String? = nil,
        noHazmat: Bool = true
    ) async throws -> LoadSearchResult {
        var body: [String: Any] = [
            "originCity": originCity,
            "destinationCity": destinationCity,
            "noHazmat": noHazmat,
        ]
        if let originState { body["originState"] = originState }
        if let destinationState { body["destinationState"] = destinationState }
        if let minRatePerMile { body["minRatePerMile"] = minRatePerMile }
        if let equipmentType { body["equipmentType"] = equipmentType }

        return try await post("/api/tools/searchLoads", body: body)
    }

    func getHOSStatus(driverId: String) async throws -> HOSStatus {
        return try await post("/api/tools/getHOSStatus", body: ["driverId": driverId])
    }

    // MARK: - Workflows

    func runLoadBooking(params: [String: Any]) async throws -> [String: Any] {
        let data = try await postRaw("/api/workflows/load-booking", body: params)
        return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
    }

    // MARK: - Driver Profile

    func getDriverProfile(driverId: String) async throws -> DriverProfile {
        return try await get("/api/drivers/\(driverId)")
    }

    // MARK: - Health

    struct HealthResponse: Codable {
        let status: String
        let service: String
        let timestamp: String
    }

    func healthCheck() async throws -> HealthResponse {
        return try await get("/health")
    }

    // MARK: - HTTP Helpers

    private func get<T: Codable>(_ path: String) async throws -> T {
        guard let url = URL(string: "\(baseURL)\(path)") else {
            throw BackendError.invalidURL
        }

        let (data, response) = try await session.data(from: url)
        try validateResponse(response)

        return try JSONDecoder().decode(T.self, from: data)
    }

    private func post<T: Codable>(_ path: String, body: [String: Any]) async throws -> T {
        let data = try await postRaw(path, body: body)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func postRaw(_ path: String, body: [String: Any]) async throws -> Data {
        guard let url = URL(string: "\(baseURL)\(path)") else {
            throw BackendError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await session.data(for: request)
        try validateResponse(response)

        return data
    }

    private func validateResponse(_ response: URLResponse) throws {
        guard let httpResponse = response as? HTTPURLResponse else {
            throw BackendError.invalidResponse
        }
        guard (200...299).contains(httpResponse.statusCode) else {
            throw BackendError.httpError(statusCode: httpResponse.statusCode)
        }
    }
}

enum BackendError: LocalizedError {
    case invalidURL
    case invalidResponse
    case httpError(statusCode: Int)

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "Invalid URL"
        case .invalidResponse: return "Invalid response from server"
        case .httpError(let code): return "Server error (HTTP \(code))"
        }
    }
}
