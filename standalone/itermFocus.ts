import { execSync, execFileSync } from 'child_process';

/**
 * Attempt to focus the iTerm2 tab running the Claude session with the given session ID.
 *
 * Strategy:
 * 1. Find `claude` process with `--session-id <sessionId>`, get its TTY
 * 2. Use osascript to find and select the iTerm2 session with that TTY
 */
export function focusItermSession(sessionId: string): boolean {
	try {
		// Find the TTY for the claude process with this session ID
		const tty = findTtyForSession(sessionId);
		if (tty) {
			return focusByTty(tty);
		}
		return false;
	} catch (err) {
		console.log(`[iTerm Focus] Error: ${err}`);
		return false;
	}
}

function findTtyForSession(sessionId: string): string | null {
	try {
		// Look for claude process with --session-id argument
		const output = execSync(
			`ps aux | grep -F "session-id ${sessionId}" | grep -v grep`,
			{ encoding: 'utf-8', timeout: 3000 },
		).trim();

		if (!output) return null;

		// Parse ps output to get the TTY column (column 7)
		const lines = output.split('\n');
		for (const line of lines) {
			const parts = line.trim().split(/\s+/);
			if (parts.length >= 7) {
				const tty = parts[6];
				if (tty && tty !== '??' && tty !== '?') {
					return tty;
				}
			}
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Launch a new iTerm2 tab and run `claude --session-id <sessionId>` in the given directory.
 */
export function launchItermSession(sessionId: string, cwd?: string): boolean {
	try {
		const script = `
on run argv
	set sid to item 1 of argv
	set cwd to item 2 of argv
	set cmd to ""
	if cwd is not "" then
		set cmd to "cd " & quoted form of cwd & " && "
	end if
	set cmd to cmd & "claude --model 'claude-opus-4-6[1m]' --resume " & sid
	tell application "iTerm2"
		activate
		if (count of windows) = 0 then
			create window with default profile
			tell current session of current window
				write text cmd
			end tell
		else
			tell current window
				set newTab to (create tab with default profile)
				tell current session of newTab
					write text cmd
				end tell
			end tell
		end if
	end tell
end run`;
		execFileSync('osascript', ['-e', script, '--', sessionId, cwd || ''], {
			encoding: 'utf-8',
			timeout: 5000,
		});
		return true;
	} catch (err) {
		console.log(`[iTerm Launch] Error: ${err}`);
		return false;
	}
}

/**
 * Launch a new iTerm2 tab and run `claude` with a specific session ID and system prompt.
 * If initialPrompt is provided, it's passed as a positional argument so the agent starts working immediately.
 */
export function launchAgentSession(
	sessionId: string, cwd: string, systemPrompt: string,
	initialPrompt?: string,
	options?: { mcpConfigPath?: string; extraFlags?: string[] }
): boolean {
	try {
		const script = `
on run argv
	set sid to item 1 of argv
	set cwd to item 2 of argv
	set sysPrompt to item 3 of argv
	set initialPrompt to item 4 of argv
	set mcpConfig to item 5 of argv
	set extraFlags to item 6 of argv
	set cmd to "cd " & quoted form of cwd & " && claude --model 'claude-opus-4-6[1m]' --session-id " & sid
	if mcpConfig is not "" then
		set cmd to cmd & " --mcp-config " & quoted form of mcpConfig
	end if
	if extraFlags is not "" then
		set cmd to cmd & " " & extraFlags
	end if
	set cmd to cmd & " --append-system-prompt " & quoted form of sysPrompt
	if initialPrompt is not "" then
		set cmd to cmd & " " & quoted form of initialPrompt
	end if
	tell application "iTerm2"
		activate
		if (count of windows) = 0 then
			create window with default profile
			tell current session of current window
				write text cmd
			end tell
		else
			tell current window
				set newTab to (create tab with default profile)
				tell current session of newTab
					write text cmd
				end tell
			end tell
		end if
	end tell
end run`;
		execFileSync('osascript', [
			'-e', script, '--',
			sessionId, cwd, systemPrompt, initialPrompt || '',
			options?.mcpConfigPath || '',
			(options?.extraFlags || []).join(' '),
		], {
			encoding: 'utf-8',
			timeout: 5000,
		});
		return true;
	} catch (err) {
		console.log(`[iTerm Launch] Error: ${err}`);
		return false;
	}
}

function focusByTty(tty: string): boolean {
	try {
		const script = `
tell application "iTerm2"
	activate
	repeat with w in windows
		repeat with t in tabs of w
			repeat with s in sessions of t
				if tty of s contains "${tty}" then
					select t
					tell w to select
					return true
				end if
			end repeat
		end repeat
	end repeat
end tell
return false
`;
		const result = execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
			encoding: 'utf-8',
			timeout: 5000,
		}).trim();

		return result === 'true';
	} catch {
		return false;
	}
}
