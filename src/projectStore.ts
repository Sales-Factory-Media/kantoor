import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LAYOUT_FILE_DIR } from './constants.js';

const KNOWN_PROJECTS_FILE = 'known-projects.json';

export interface KnownProject {
	name: string;
	workspacePath: string;
	description?: string;
}

function getFilePath(): string {
	return path.join(os.homedir(), LAYOUT_FILE_DIR, KNOWN_PROJECTS_FILE);
}

export function loadKnownProjects(): KnownProject[] {
	const filePath = getFilePath();
	try {
		if (!fs.existsSync(filePath)) return [];
		const raw = fs.readFileSync(filePath, 'utf-8');
		const data = JSON.parse(raw) as KnownProject[];
		return Array.isArray(data) ? data : [];
	} catch {
		return [];
	}
}

function writeKnownProjects(projects: KnownProject[]): void {
	const filePath = getFilePath();
	const dir = path.dirname(filePath);
	try {
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		const json = JSON.stringify(projects, null, 2);
		const tmpPath = filePath + '.tmp';
		fs.writeFileSync(tmpPath, json, 'utf-8');
		fs.renameSync(tmpPath, filePath);
	} catch (err) {
		console.error('[Pixel Agents] Failed to write known projects:', err);
	}
}

export function addKnownProject(name: string, workspacePath: string): void {
	const projects = loadKnownProjects();
	if (projects.some((p) => p.workspacePath === workspacePath)) return;
	projects.push({ name, workspacePath });
	writeKnownProjects(projects);
}

export function removeKnownProject(workspacePath: string): void {
	const projects = loadKnownProjects();
	const filtered = projects.filter((p) => p.workspacePath !== workspacePath);
	if (filtered.length !== projects.length) {
		writeKnownProjects(filtered);
	}
}

export function removeKnownProjectByName(name: string): void {
	const projects = loadKnownProjects();
	const filtered = projects.filter((p) => p.name !== name);
	if (filtered.length !== projects.length) {
		writeKnownProjects(filtered);
	}
}

export function updateKnownProject(workspacePath: string, updates: Partial<Omit<KnownProject, 'workspacePath'>>): void {
	const projects = loadKnownProjects();
	const idx = projects.findIndex(p => p.workspacePath === workspacePath);
	if (idx === -1) return;
	projects[idx] = { ...projects[idx], ...updates };
	writeKnownProjects(projects);
}

/** Get known projects filtered to those whose workspace path is in the current VS Code window */
export function getKnownProjectsForWorkspace(workspaceFolderPaths: string[]): KnownProject[] {
	const all = loadKnownProjects();
	const pathSet = new Set(workspaceFolderPaths);
	return all.filter((p) => pathSet.has(p.workspacePath));
}
