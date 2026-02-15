import Foundation

struct DriverProfile: Codable, Identifiable {
    let id: String
    var name: String
    var email: String?
    var phone: String?
    var mcNumber: String?
    var dotNumber: String?
    var equipmentType: EquipmentType
    var tankCapacity: Int
    var avgMPG: Double
    var preferredLanes: [PreferredLane]
    var avoidStates: [String]
    var maxWeight: Int
    var hasHazmat: Bool
    var hasTWIC: Bool
    var homeBase: String?
    var minRatePerMile: Double?

    enum EquipmentType: String, Codable, CaseIterable {
        case dryVan = "dry_van"
        case reefer
        case flatbed
        case stepDeck = "step_deck"
        case other

        var displayName: String {
            switch self {
            case .dryVan: return "Dry Van"
            case .reefer: return "Reefer"
            case .flatbed: return "Flatbed"
            case .stepDeck: return "Step Deck"
            case .other: return "Other"
            }
        }
    }

    struct PreferredLane: Codable {
        let origin: String
        let destination: String
        let minRate: Double
    }
}
