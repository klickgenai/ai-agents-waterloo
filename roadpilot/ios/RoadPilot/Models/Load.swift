import Foundation

struct Load: Codable, Identifiable {
    let id: String
    let origin: Location
    let destination: Location
    let rate: Double
    let ratePerMile: Double
    let distance: Int
    let weight: Int?
    let equipmentType: String
    let hazmat: Bool
    let pickupDate: String
    let deliveryDate: String
    let brokerName: String
    let brokerPhone: String
    let brokerEmail: String?
    let postedAt: String
    let notes: String?

    struct Location: Codable {
        let city: String
        let state: String
        let zip: String
    }
}

struct LoadSearchResult: Codable {
    let loads: [Load]
    let totalFound: Int
    let searchParams: SearchParams

    struct SearchParams: Codable {
        let origin: String
        let destination: String
        let filters: String
    }
}

struct ProfitabilityResult: Codable {
    let loadId: String
    let grossRevenue: Double
    let fuelCost: Double
    let tollCost: Double
    let operatingCost: Double
    let netProfit: Double
    let profitPerMile: Double
    let profitMargin: Double
    let recommendation: String
}
