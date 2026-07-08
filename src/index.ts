// First call so the imports can use the variable
import path from "path";
export const projPath = path.resolve(__dirname, "..");

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAllHandlers } from "./handlers";
import { config } from "dotenv";

import { exit } from "process";
import "./utils/logging"; // Removed .js again
import { writeToErrLog, writeToLog } from "./utils/logging"; // Removed .js again
import { McpServerWithMiddleware } from "./utils/middleware";
import './utils/exitHandler';
import { registerDeleteTempOnExit } from "./utils/exitHandler";

process.on("uncaughtException", (err) => {
	logError(err);
	exit(2);
});

// Allow passing a custom .env file path as a CLI argument.
// Supports `--env-file <path>`, `--env-file=<path>`, or a bare path as the first argument.
const getEnvFilePath = (): string => {
	const args = process.argv.slice(2);

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--env-file" || arg === "-e") {
			if (args[i + 1]) {
				return path.resolve(args[i + 1]);
			}
		} else if (arg.startsWith("--env-file=")) {
			return path.resolve(arg.slice("--env-file=".length));
		}
	}

	// Fall back to the first non-flag argument, then to the default location.
	const bareArg = args.find((arg) => !arg.startsWith("-"));
	if (bareArg) {
		return path.resolve(bareArg);
	}

	return path.join(projPath, ".env");
};

config({ path: getEnvFilePath() });

const server = new McpServerWithMiddleware({
	name: "integration-suite",
	version: "1.0.0",
}, {
	capabilities: {
		resources: {},
		tools: {},
	},
});

registerAllHandlers(server);

async function main() {
	registerDeleteTempOnExit();
	const transport = new StdioServerTransport();

	await server.connect(transport);
}

export const logError = (msg: any): void => {
	writeToErrLog(msg);
	try {
		// just causes lots of error messages on most client because it is not implemented
		//server.server.sendLoggingMessage({level: "error", data: JSON.stringify(msg)});
	} catch { }
};

export const logInfo = (msg: any): void => {
	writeToLog(msg);
	try {
		//server.server.sendLoggingMessage({level: "info", data: JSON.stringify(msg)});
	} catch { }
};

if (!process.env.JEST_WORKER_ID) {
	main()
		.catch((err) => {
			logError(err);
			console.error(err);
			exit(1);
		})
		.then(() => writeToLog("server started"));

}
