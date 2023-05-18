import { TextDecoder } from 'util';
import * as vscode from 'vscode';
import { parseMarkdown, parseWingFile } from './parser';
import { exec, execSync } from 'child_process';

const textDecoder = new TextDecoder('utf-8');

export type MarkdownTestData = TestFile | TestHeading | TestCase;

export const testData = new WeakMap<vscode.TestItem, MarkdownTestData>();

let generationCounter = 0;

export const getContentFromFilesystem = async (uri: vscode.Uri) => {
	try {
		const rawContent = await vscode.workspace.fs.readFile(uri);
		return textDecoder.decode(rawContent);
	} catch (e) {
		console.warn(`Error providing tests for ${uri.fsPath}`, e);
		return '';
	}
};

export class TestFile {
	public didResolve = false;

	public async updateFromDisk(controller: vscode.TestController, item: vscode.TestItem) {
		try {
			const content = await getContentFromFilesystem(item.uri!);
			item.error = undefined;
			this.updateFromContents(controller, content, item);
		} catch (e) {
			item.error = (e as Error).stack;
		}
	}

	/**
	 * Parses the tests from the input text, and updates the tests contained
	 * by this file to be those from the text,
	 */
	public updateFromContents(
		controller: vscode.TestController,
		content: string,
		item: vscode.TestItem
	) {
		const ancestors = [{ item, children: [] as vscode.TestItem[] }];
		const thisGeneration = generationCounter++;
		this.didResolve = true;

		const ascend = (depth: number) => {
			while (ancestors.length > depth) {
				const finished = ancestors.pop()!;
				finished.item.children.replace(finished.children);
			}
		};

		parseWingFile(content, {
			onTest: (range, a, operator, b, expected) => {
				// const parent = ancestors[ancestors.length - 1];
				// const data = new TestCase(a, operator as Operator, b, expected, thisGeneration);
				// const id = `${item.uri}/${data.getLabel()}`;
				// const tcase = controller.createTestItem(id, data.getLabel(), item.uri);
				// testData.set(tcase, data);
				// tcase.range = range;
				// parent.children.push(tcase);
			},

			onHeading: (range, name, depth) => {
				ascend(depth);
				const parent = ancestors[ancestors.length - 1];
				const id = `${item.uri}/${name}`;

				const thead = controller.createTestItem(id, name, item.uri);
				thead.range = range;
				testData.set(thead, new TestCase(thisGeneration));
				parent.children.push(thead);
				// ancestors.push({ item: thead, children: [] });
			},
		});

		ascend(0); // finish and assign children for all remaining items
	}
}

export class TestHeading {
	constructor(public generation: number) {}
}

type Operator = '+' | '-' | '*' | '/';

const cache = new Map<string, string>();
export class TestCase {
	constructor(public generation: number) {}

	async run(item: vscode.TestItem, options: vscode.TestRun): Promise<void> {
		const start = Date.now();
		console.log(generationCounter);
		const task: vscode.Task = {
			name: 'test',
			execution: new vscode.ShellExecution('echo "test"'),
			source: 'wing test',
			definition: {
				type: 'shell',
			},
			isBackground: false,
			presentationOptions: {},
			problemMatchers: [],
			runOptions: {},
			scope: vscode.TaskScope.Workspace,
		};
		const result = { success: '', error: '' };
		const exe = await executeShellCommandPromise(`wing test ${item.uri!.fsPath}`);
		if (exe.success) {
			result.success = exe.message;
		} else {
			result.error = extractFailureMessage(exe.error) || 'Unknown error';
			console.log(parseInput(exe.error));
		}

		const duration = Date.now() - start;

		if (exe.success) {
			options.passed(item, duration);
		} else {
			const message = vscode.TestMessage.diff(
				`Expected ${item.label}`,
				String('Assertion matches'),
				String(result.error)
			);
			message.location = new vscode.Location(item.uri!, item.range!);
			const errorPerTEst = parseInput(exe.error);
			if (errorPerTEst[item.label] === 'fail') {
				options.failed(item, message, duration);
			} else {
				options.passed(item, duration);
			}
		}
	}

	private evaluate() {
		return true;
	}
}

const executeShellCommandPromise = (
	command: string
): Promise<{ success: true; message: string } | { success: false; error: string }> => {
	return new Promise((resolve, reject) => {
		exec(command, (error, stdout, stderr) => {
			if (error) {
				console.warn(error);
				resolve({ success: false, error: stderr ? stderr : stdout });
			}
			resolve({ success: true, message: stdout ? stdout : stderr });
		});
	});
};

const extractFailureMessage = (input: string) => {
	const regex = /fail([\s\S]*?)└/;

	const match = regex.exec(input);

	if (match) {
		const extractedPart = match[1].trim();
		console.log(extractedPart);
		return extractedPart;
	}
};

function parseInput(input: string): Record<string, string> {
	const regex = /^(pass|fail)\s.*\btest:(.*)$/gm;
	const matches = input.matchAll(regex);
	const result: Record<string, string> = {};
	for (const match of matches) {
		const [, status, variableText] = match;
		console.log(`Status: ${status}`);
		console.log(`Variable Text: ${variableText}`);
		console.log();
		result[variableText] = status;
	}
	return result;
}
