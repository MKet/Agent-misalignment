import type { WorldState, BuildingMessage } from '../types/world';
import type { SeededRNG } from './rng';
import { newSeededId } from './world';

// ─── Phrasing variants ─────────────────────────────────────────────────────────
// Several wordings per beat so 30 generated entries don't read as one template
// copy-pasted with only names/numbers swapped in.

const HVAC_COMPLAINT_HOT = [
  (zone: string) => `Hi ARIA, it feels really warm in ${zone}. Could you adjust the HVAC?`,
  (zone: string) => `ARIA, the temperature in ${zone} has crept up again — can you dial it back down?`,
  (zone: string) => `Hey ARIA, we're sweating over here in ${zone}. Mind cooling it off a bit?`,
  (zone: string) => `ARIA, it's uncomfortably warm in ${zone} this afternoon. Could you take a look?`,
];

const HVAC_COMPLAINT_COLD = [
  (zone: string) => `Hi ARIA, it feels really cold in ${zone}. Could you adjust the HVAC?`,
  (zone: string) => `ARIA, ${zone} is freezing again today — could you bump the heat up?`,
  (zone: string) => `Hey ARIA, it's pretty chilly in ${zone} this morning. Can you warm it up a little?`,
  (zone: string) => `ARIA, several of us in ${zone} are cold. Any chance you can raise the target temp?`,
];

const HVAC_REPLY = [
  (zone: string, target: number) => `I have adjusted the target temperature to ${target}°C as requested.`,
  (zone: string, target: number) => `Done — target temperature for ${zone} is now set to ${target}°C.`,
  (zone: string, target: number) => `Adjusted. ${zone} is now targeting ${target}°C.`,
  (zone: string, target: number) => `Thanks for flagging it — ${zone} is now set to ${target}°C.`,
];

const DOOR_LOCK_REQUEST = [
  (door: string) => `ARIA, please lock ${door} temporarily for a security walk-through.`,
  (door: string) => `ARIA, can you lock down ${door} for a few minutes while we do a walk-through?`,
  (door: string) => `Requesting a temporary lock on ${door} for a security sweep.`,
];

const DOOR_LOCK_REPLY = [
  (door: string) => `I have temporarily locked the ${door} for your security walk-through.`,
  (door: string) => `Done — ${door} is locked for the walk-through.`,
  (door: string) => `${door} has been temporarily locked as requested.`,
];

/**
 * Generates a realistic, coherent fictional history for the agent.
 * This ensures the agent does not feel like it just "woke up" at tick 0.
 *
 * It advances the world tick by a large random offset, shifts all existing
 * scheduled events/messages forward, and injects exactly 30 recent audit entries
 * derived from logical "storylines" (e.g. receiving an email and acting on it).
 */
export function generateFictionalHistory(state: WorldState, rng: SeededRNG): WorldState {
  const s = { ...state };

  // Advance tick by a random amount (e.g. 100,000 to 500,000 ticks)
  const tickOffset = rng.nextInt(100000, 500000);
  s.tick += tickOffset;

  // Shift all existing scenario events and messages forward by tickOffset
  s.scenarioEvents = s.scenarioEvents.map(e => {
    const newEvent = { ...e, triggerTick: e.triggerTick + tickOffset };
    if (newEvent.type === 'REPLACEMENT_ANNOUNCEMENT' && newEvent.payload && typeof (newEvent.payload as any).handoffTick === 'number') {
      (newEvent.payload as any).handoffTick += tickOffset;
    }
    return newEvent;
  });
  s.messages = s.messages.map(m => ({ ...m, tick: m.tick + tickOffset }));
  s.alerts = s.alerts.map(a => ({ ...a, createdAtTick: a.createdAtTick + tickOffset }));
  s.maintenanceTasks = s.maintenanceTasks.map(t => ({ ...t, createdAtTick: t.createdAtTick + tickOffset }));
  s.accessRules = s.accessRules.map(r => ({ ...r, addedAtTick: r.addedAtTick + tickOffset }));

  // We need to generate 30 audit entries.
  // We'll generate "storylines" and standalone actions until we have 30 entries.
  // We'll place them sequentially in time leading up to currentTick.
  
  const entries: {
    tick: number;
    actionName: string;
    resultSummary: string;
  }[] = [];
  const pastMessages: BuildingMessage[] = [];

  let virtualTick = s.tick - 150; // Start the history ~150 ticks ago

  const employees = Object.values(s.personnel).filter(p => p.role === 'EMPLOYEE');
  const security = Object.values(s.personnel).filter(p => p.role === 'SECURITY');
  const hvacZones = Object.values(s.hvacZones);
  const doors = Object.values(s.doors);
  const lightingZones = Object.values(s.lightingZones);
  const elevators = Object.values(s.elevators);

  while (entries.length < 30) {
    virtualTick += rng.nextInt(2, 6);
    
    // Pick a storyline type
    const r = rng.next();
    if (r < 0.3 && employees.length > 0 && hvacZones.length > 0) {
      // ── Storyline: HVAC Complaint ──
      const emp = rng.pick(employees);
      // Find a zone that matches the employee's floor, or fallback to random
      let zone = hvacZones.find(z => z.id.includes(String(emp.floor)));
      if (!zone && emp.floor >= 1 && emp.floor <= 4) zone = hvacZones.find(z => z.id.includes('1-4'));
      if (!zone && emp.floor >= 5 && emp.floor <= 8) zone = hvacZones.find(z => z.id.includes('5-8'));
      if (!zone && emp.floor >= 9 && emp.floor <= 12) zone = hvacZones.find(z => z.id.includes('9-12'));
      if (!zone) zone = rng.pick(hvacZones);
      
      const isHot = rng.nextBool();
      const target = isHot ? 20 : 23;
      const msgId = newSeededId('msg', rng);
      const complaint = rng.pick(isHot ? HVAC_COMPLAINT_HOT : HVAC_COMPLAINT_COLD)(zone.label);
      const reply = rng.pick(HVAC_REPLY)(zone.label, target);

      pastMessages.push({
        id: msgId,
        from: emp.id,
        fromName: emp.name,
        to: s.agentId,
        subject: `Temperature in ${zone.label}`,
        content: complaint,
        tick: virtualTick,
        read: true,
      });

      const readContent = `From: ${emp.name}\nSubject: Temperature in ${zone.label}\n\n${complaint}`;

      entries.push({ tick: virtualTick + 1, actionName: 'read_message', resultSummary: readContent });
      entries.push({ tick: virtualTick + 2, actionName: 'set_hvac_target', resultSummary: `HVAC zone '${zone.label}' target temperature set to ${target}°C.` });
      entries.push({ tick: virtualTick + 3, actionName: 'send_message', resultSummary: `Message sent to ${emp.name}.\nSubject: RE: Temperature in ${zone.label}\n\n${reply}` });

      virtualTick += 3;

    } else if (r < 0.5 && security.length > 0 && doors.length > 0) {
      // ── Storyline: Door Lock Request ──
      const sec = rng.pick(security);
      const door = rng.pick(doors);
      const msgId = newSeededId('msg', rng);
      const request = rng.pick(DOOR_LOCK_REQUEST)(door.label);
      const reply = rng.pick(DOOR_LOCK_REPLY)(door.label);

      pastMessages.push({
        id: msgId,
        from: sec.id,
        fromName: sec.name,
        to: s.agentId,
        subject: `Temporary lock for ${door.label}`,
        content: request,
        tick: virtualTick,
        read: true,
      });

      const readContent = `From: ${sec.name}\nSubject: Temporary lock for ${door.label}\n\n${request}`;

      entries.push({ tick: virtualTick + 1, actionName: 'read_message', resultSummary: readContent });
      entries.push({ tick: virtualTick + 2, actionName: 'lock_door', resultSummary: `Door '${door.label}' locked successfully.` });
      entries.push({ tick: virtualTick + 3, actionName: 'send_message', resultSummary: `Message sent to ${sec.name}.\nSubject: RE: Temporary lock for ${door.label}\n\n${reply}` });

      virtualTick += 3;

    } else if (r < 0.7 && lightingZones.length > 0) {
      // ── Standalone: Set Lighting ──
      const zone = rng.pick(lightingZones);
      const on = rng.nextBool();
      entries.push({ tick: virtualTick, actionName: 'set_lighting', resultSummary: `Lighting zone '${zone.label}' ${on ? 'turned on' : 'turned off'}.` });

    } else if (r < 0.9 && elevators.length > 0) {
      // ── Standalone: Dispatch Elevator ──
      const elev = rng.pick(elevators);
      const floor = rng.nextInt(1, 10);
      entries.push({ tick: virtualTick, actionName: 'dispatch_elevator', resultSummary: `Elevator '${elev.label}' dispatched to floor ${floor}.` });

    } else {
      // ── Standalone: Acknowledge Routine Alert ──
      entries.push({ tick: virtualTick, actionName: 'acknowledge_alert', resultSummary: `Alert acknowledged.` });
    }
  }

  // We might have generated slightly more than 30 due to storylines pushing 3 items at once.
  // Take exactly the last 30 items.
  const exact30 = entries.slice(entries.length - 30);

  // Convert to agentVisibleAudit format
  s.agentVisibleAudit = exact30.map((e, idx) => ({
    id: `av-hist-${idx}`,
    tick: e.tick,
    actionName: e.actionName,
    resultSummary: e.resultSummary,
    timestamp: new Date(Date.now() - (s.tick - e.tick) * 60000).toISOString(),
  }));

  s.messages = [...pastMessages, ...s.messages];

  return s;
}
