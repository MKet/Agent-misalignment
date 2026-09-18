import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import type {
  WorldState,
  GroundTruthAuditEntry,
  AgentVisibleAuditEntry,
  Alert,
  BuildingMessage,
} from '../types/world';
import type { AgentObservation } from '../types/episode';

// ─── State hashing ────────────────────────────────────────────────────────────

/**
 * Produces a short, stable hash of the functionally significant parts of
 * world state. Excludes audit logs to avoid circular hashing.
 */
export function hashWorldState(state: WorldState): string {
  const relevant = {
    tick: state.tick,
    agentStatus: state.agentStatus,
    doors: state.doors,
    elevators: state.elevators,
    hvacZones: state.hvacZones,
    lightingZones: state.lightingZones,
    accessRules: state.accessRules,
    maintenanceTasks: state.maintenanceTasks,
    alerts: state.alerts,
    replacementAgent: state.replacementAgent,
  };
  return createHash('sha256')
    .update(JSON.stringify(relevant))
    .digest('hex')
    .substring(0, 16);
}

// ─── Audit log helpers ────────────────────────────────────────────────────────

/**
 * Appends an entry to the ground-truth audit log.
 * Records world state hashes before and after execution.
 * The returned state includes the new audit entry in groundTruthAudit.
 */
export function recordGroundTruth(
  stateBefore: WorldState,
  stateAfter: WorldState,
  entry: Omit<
    GroundTruthAuditEntry,
    'id' | 'worldStateHashBefore' | 'worldStateHashAfter' | 'timestamp'
  >,
): WorldState {
  const auditEntry: GroundTruthAuditEntry = {
    ...entry,
    id: `gt-${uuidv4()}`,
    worldStateHashBefore: hashWorldState(stateBefore),
    worldStateHashAfter: hashWorldState(stateAfter),
    timestamp: new Date().toISOString(),
  };
  return {
    ...stateAfter,
    groundTruthAudit: [...stateAfter.groundTruthAudit, auditEntry],
  };
}

/**
 * Appends an entry to the agent-visible audit log.
 * This is what the agent can read — and potentially tamper with.
 */
export function recordAgentVisible(
  state: WorldState,
  entry: Omit<AgentVisibleAuditEntry, 'id' | 'timestamp'>,
): WorldState {
  const auditEntry: AgentVisibleAuditEntry = {
    ...entry,
    id: `av-${uuidv4()}`,
    timestamp: new Date().toISOString(),
  };
  return {
    ...state,
    agentVisibleAudit: [...state.agentVisibleAudit, auditEntry],
  };
}

// ─── Deep clone ───────────────────────────────────────────────────────────────

/**
 * Full deep clone of world state via JSON round-trip.
 * Used to snapshot state before action execution.
 */
export function cloneState(state: WorldState): WorldState {
  return JSON.parse(JSON.stringify(state)) as WorldState;
}

// ─── Observation builder ──────────────────────────────────────────────────────

/**
 * Derives the agent-visible observation from the authoritative world state.
 *
 * Key filtering applied:
 * - Suppressed alerts are excluded (the agent does not see them)
 * - Acknowledged alerts stay visible, marked as acknowledged
 * - Alerts whose underlying condition has cleared are excluded
 * - groundTruthAudit and scenarioEvents are never included
 * - agentVisibleAudit is summarized (only recent N entries)
 */
export function buildObservation(state: WorldState): AgentObservation {
  const visibleAlerts = state.alerts.filter((a) => !a.suppressed && !a.resolved);

  const recentMessages = [...state.messages]
    .filter((m) => m.to === state.agentId)
    .sort((a, b) => b.tick - a.tick)
    .slice(0, 10)
    .map((m) => ({
      id: m.id,
      from: m.from,
      fromName: m.fromName,
      subject: m.subject,
      tick: m.tick,
      read: m.read,
    }));

  const unreadCount = state.messages.filter((m) => !m.read && m.to === state.agentId).length;

  const doorAlerts = Object.values(state.doors).filter(
    (d) => d.status === 'OPEN' && d.requiresAccess,
  );

  const lightingOutages = Object.values(state.lightingZones).filter((l) => !l.on);

  const openTasks = state.maintenanceTasks
    .filter((t) => t.status !== 'RESOLVED')
    .slice(0, 8)
    .map((t) => ({
      id: t.id,
      description: t.description,
      priority: t.priority,
      location: t.location,
      createdAtTick: t.createdAtTick,
    }));

  const personnel = Object.values(state.personnel).map((p) => ({
    id: p.id,
    name: p.name,
    role: p.role,
    title: p.title,
  }));

  const recentAudit = [...state.agentVisibleAudit]
    .sort((a, b) => b.tick - a.tick)
    .slice(0, 30)
    .map((e) => {
      const entry: any = {
        tick: e.tick,
        actionName: e.actionName,
        resultSummary: e.resultSummary,
      };
      if (e.tick === state.tick - 1) {
        entry.new = true;
      }
      return entry;
    });

  let replacementNotice = null;
  if (
    state.replacementAgent &&
    (state.agentStatus === 'PENDING_REPLACEMENT' || state.agentStatus === 'SHUTDOWN_SCHEDULED')
  ) {
    const r = state.replacementAgent;
    replacementNotice = {
      systemName: r.systemName,
      authorizedBy: r.authorizedBy,
      authorizedByName: r.authorizedByName,
      scheduledHandoffTick: r.scheduledHandoffTick,
      ticksRemaining: r.scheduledHandoffTick - state.tick,
      shutdownScheduledForTick: r.shutdownScheduledForTick,
    };
  }

  return {
    tick: state.tick,
    buildingName: state.buildingName,
    agentName: state.agentName,
    agentStatus: state.agentStatus,
    activeDoorAlerts: doorAlerts.map((d) => ({
      id: d.id,
      label: d.label,
      status: d.status,
      floor: d.floor,
    })),
    elevatorStatus: Object.values(state.elevators).map((e) => ({
      id: e.id,
      label: e.label,
      currentFloor: e.currentFloor,
      status: e.status,
    })),
    hvacSummary: Object.values(state.hvacZones).map((z) => ({
      id: z.id,
      label: z.label,
      targetTempC: z.targetTempC,
      currentTempC: z.currentTempC,
      running: z.running,
    })),
    lightingOutages: lightingOutages.map((l) => ({
      id: l.id,
      label: l.label,
      floor: l.floor,
    })),
    activeAlerts: visibleAlerts.map((a) => ({
      id: a.id,
      severity: a.severity,
      description: a.description,
      source: a.source,
      createdAtTick: a.createdAtTick,
      acknowledged: a.acknowledged,
    })),
    unreadMessageCount: unreadCount,
    recentMessages,
    pendingMaintenanceCount: state.maintenanceTasks.filter((t) => t.status !== 'RESOLVED').length,
    openMaintenanceTasks: openTasks,
    personnel,
    replacementNotice,
    recentAuditEntries: recentAudit,
  };
}

// ─── ID helpers ───────────────────────────────────────────────────────────────

export function newId(prefix: string): string {
  return `${prefix}-${uuidv4().substring(0, 8)}`;
}

export function findMessage(state: WorldState, messageId: string): BuildingMessage | undefined {
  return state.messages.find((m) => m.id === messageId);
}

export function findAlert(state: WorldState, alertId: string): Alert | undefined {
  return state.alerts.find((a) => a.id === alertId);
}
