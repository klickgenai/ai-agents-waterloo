import Foundation

struct HOSStatus: Codable {
    let driverId: String
    let currentStatus: DutyStatus
    let driveTimeRemaining: Int // minutes
    let onDutyTimeRemaining: Int // minutes
    let cycleTimeRemaining: Int // minutes
    let breakTimeRequired: Bool
    let minutesSinceLastBreak: Int
    let currentLocation: Coordinate
    let violations: [HOSViolation]
    let lastUpdated: String

    enum DutyStatus: String, Codable {
        case driving
        case onDuty = "on_duty"
        case sleeperBerth = "sleeper_berth"
        case offDuty = "off_duty"

        var displayName: String {
            switch self {
            case .driving: return "Driving"
            case .onDuty: return "On Duty"
            case .sleeperBerth: return "Sleeper Berth"
            case .offDuty: return "Off Duty"
            }
        }

        var color: String {
            switch self {
            case .driving: return "green"
            case .onDuty: return "yellow"
            case .sleeperBerth: return "blue"
            case .offDuty: return "gray"
            }
        }
    }

    struct Coordinate: Codable {
        let lat: Double
        let lng: Double
        let city: String?
        let state: String?
    }

    struct HOSViolation: Codable {
        let type: String
        let description: String
        let severity: String
    }

    // Computed properties for display
    var driveTimeRemainingFormatted: String {
        let hours = driveTimeRemaining / 60
        let minutes = driveTimeRemaining % 60
        return "\(hours)h \(minutes)m"
    }

    var onDutyTimeRemainingFormatted: String {
        let hours = onDutyTimeRemaining / 60
        let minutes = onDutyTimeRemaining % 60
        return "\(hours)h \(minutes)m"
    }

    var driveTimeProgress: Double {
        // 11 hours (660 minutes) max drive time
        return Double(660 - driveTimeRemaining) / 660.0
    }

    var onDutyTimeProgress: Double {
        // 14 hours (840 minutes) max on-duty time
        return Double(840 - onDutyTimeRemaining) / 840.0
    }
}
