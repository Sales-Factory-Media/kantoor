import { DARRYL_ROLE_SHORT, JAN_ROLE_SHORT } from './constants.js';
import { loadKnownProjects } from '../src/projectStore.js';
import type { PersistentAgent } from './agentStore.js';
import { TEAMS } from './agentStore.js';

export type OrganogramNodeType = 'person' | 'team' | 'project';

export interface OrganogramNode {
	id: string;
	parentId: string | null;
	name: string;
	roleShort: string;
	roleFull: string;
	isOnline: boolean;
	nodeType: OrganogramNodeType;
	currentTicketId?: string;
	currentTicketName?: string;
}

export interface OrganogramPayload {
	nodes: OrganogramNode[];
}

export function buildOrganogram(persistentAgents: PersistentAgent[]): OrganogramPayload {
	const nodes: OrganogramNode[] = [];

	// ── Jasper (root) ──
	const jasperId = '__jasper__';
	nodes.push({
		id: jasperId,
		parentId: null,
		name: 'Jasper',
		roleShort: 'Owner',
		roleFull: 'Owner',
		isOnline: true,
		nodeType: 'person',
	});

	// ── Darryl ──
	const darryl = persistentAgents.find(p => p.roleShort === DARRYL_ROLE_SHORT);
	const darrylId = darryl?.id ?? '__darryl__';
	nodes.push({
		id: darrylId,
		parentId: jasperId,
		name: 'Darryl',
		roleShort: 'Foreman',
		roleFull: 'The Foreman. Assesses tickets and dispatches agents.',
		isOnline: darryl ? !!darryl.currentSessionId : false,
		nodeType: 'person',
		currentTicketId: darryl?.currentTicketId,
		currentTicketName: darryl?.currentTicketName,
	});

	// ── Darryl's teams: one per known project ──
	const knownProjects = loadKnownProjects();
	// Collect dev agents (not Jan, not design team members, not Darryl)
	const designAgentIds = new Set<string>();
	const jan = persistentAgents.find(p => p.roleShort === JAN_ROLE_SHORT);
	if (jan) designAgentIds.add(jan.id);
	for (const team of Object.values(TEAMS)) {
		for (const a of persistentAgents) {
			if (a.teamId === team.id) designAgentIds.add(a.id);
		}
	}
	const devAgents = persistentAgents.filter(
		p => p.id !== darrylId && !designAgentIds.has(p.id) && !p.retired,
	);

	// Group dev agents by workspacePath
	const agentsByWorkspace = new Map<string, PersistentAgent[]>();
	for (const a of devAgents) {
		const ws = a.workspacePath || '~/unknown';
		if (!agentsByWorkspace.has(ws)) agentsByWorkspace.set(ws, []);
		agentsByWorkspace.get(ws)!.push(a);
	}

	// Also add project nodes for known projects that have no agents yet
	for (const kp of knownProjects) {
		const wsKey = kp.workspacePath;
		if (!agentsByWorkspace.has(wsKey)) agentsByWorkspace.set(wsKey, []);
	}

	// Build a project name lookup from known projects
	const projectNameByWorkspace = new Map<string, string>();
	for (const kp of knownProjects) {
		projectNameByWorkspace.set(kp.workspacePath, kp.name);
	}

	for (const [workspace, agents] of agentsByWorkspace) {
		const projectName = projectNameByWorkspace.get(workspace)
			?? workspace.split('/').pop()
			?? 'Unknown';
		const projectNodeId = `__project__${workspace}`;
		nodes.push({
			id: projectNodeId,
			parentId: darrylId,
			name: projectName,
			roleShort: 'Project',
			roleFull: workspace,
			isOnline: agents.some(a => !!a.currentSessionId),
			nodeType: 'project',
		});
		for (const a of agents) {
			nodes.push({
				id: a.id,
				parentId: projectNodeId,
				name: a.name,
				roleShort: a.roleShort,
				roleFull: a.roleFull,
				isOnline: !!a.currentSessionId,
				nodeType: 'person',
				currentTicketId: a.currentTicketId,
				currentTicketName: a.currentTicketName,
			});
		}
	}

	// ── Jan (Art Director) ──
	const janId = jan?.id ?? '__jan__';
	nodes.push({
		id: janId,
		parentId: jasperId,
		name: 'Jan',
		roleShort: JAN_ROLE_SHORT,
		roleFull: 'The Art Director. Heads both design teams.',
		isOnline: jan ? !!jan.currentSessionId : false,
		nodeType: 'person',
		currentTicketId: jan?.currentTicketId,
		currentTicketName: jan?.currentTicketName,
	});

	// ── Jan's design teams ──
	for (const team of Object.values(TEAMS)) {
		const teamNodeId = `__team__${team.id}`;
		const members = persistentAgents.filter(p => p.teamId === team.id);
		nodes.push({
			id: teamNodeId,
			parentId: janId,
			name: team.name,
			roleShort: 'Team',
			roleFull: team.name,
			isOnline: members.some(m => !!m.currentSessionId),
			nodeType: 'team',
		});

		const qa = members.find(p => p.roleShort === team.qaRole && !p.retired);
		const workers = members.filter(p => p.roleShort === team.workerRole && !p.retired);

		if (qa) {
			nodes.push({
				id: qa.id,
				parentId: teamNodeId,
				name: qa.name,
				roleShort: 'QA',
				roleFull: qa.roleFull,
				isOnline: !!qa.currentSessionId,
				nodeType: 'person',
				currentTicketId: qa.currentTicketId,
				currentTicketName: qa.currentTicketName,
			});
		}
		for (const w of workers) {
			nodes.push({
				id: w.id,
				parentId: teamNodeId,
				name: w.name,
				roleShort: w.roleShort,
				roleFull: w.roleFull,
				isOnline: !!w.currentSessionId,
				nodeType: 'person',
				currentTicketId: w.currentTicketId,
				currentTicketName: w.currentTicketName,
			});
		}
	}

	return { nodes };
}
