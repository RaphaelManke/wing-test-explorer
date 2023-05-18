import * as vscode from 'vscode';
import { getContentFromFilesystem, TestCase, testData, TestFile } from './testTree';
const fileEnding = 'w';
const filePattern = `**/*.${fileEnding}}`;

export async function activate(context: vscode.ExtensionContext) {
	const ctrl = vscode.tests.createTestController('wingTestController', 'Wing Tests');
	context.subscriptions.push(ctrl);

	const fileChangedEmitter = new vscode.EventEmitter<vscode.Uri>();
	const runHandler = (
		request: vscode.TestRunRequest2,
		cancellation: vscode.CancellationToken
	) => {
		if (!request.continuous) {
			return startTestRun(request);
		}

		const l = fileChangedEmitter.event((uri) =>
			startTestRun(
				new vscode.TestRunRequest2(
					[getOrCreateFile(ctrl, uri).file],
					undefined,
					request.profile,
					true
				)
			)
		);
		cancellation.onCancellationRequested(() => l.dispose());
	};

	const startTestRun = (request: vscode.TestRunRequest) => {
		const queue: { test: vscode.TestItem; data: TestCase }[] = [];
		const run = ctrl.createTestRun(request);
		// map of file uris to statements on each line:
		const coveredLines = new Map<
			/* file uri */ string,
			(vscode.StatementCoverage | undefined)[]
		>();

		const discoverTests = async (tests: Iterable<vscode.TestItem>) => {
			for (const test of tests) {
				if (request.exclude?.includes(test)) {
					continue;
				}

				const data = testData.get(test);
				if (data instanceof TestCase) {
					run.enqueued(test);
					queue.push({ test, data });
				} else {
					if (data instanceof TestFile && !data.didResolve) {
						await data.updateFromDisk(ctrl, test);
					}

					await discoverTests(gatherTestItems(test.children));
				}

				if (test.uri && !coveredLines.has(test.uri.toString())) {
					try {
						const lines = (await getContentFromFilesystem(test.uri)).split(
							'\n'
						);
						coveredLines.set(
							test.uri.toString(),
							lines.map((lineText, lineNo) =>
								lineText.trim().length
									? new vscode.StatementCoverage(
											0,
											new vscode.Position(lineNo, 0)
											// eslint-disable-next-line no-mixed-spaces-and-tabs
									  )
									: undefined
							)
						);
					} catch {
						// ignored
					}
				}
			}
		};

		const runTestQueue = async () => {
			for (const { test, data } of queue) {
				run.appendOutput(`Running ${test.id}\r\n`);
				if (run.token.isCancellationRequested) {
					run.skipped(test);
				} else {
					run.started(test);
					await data.run(test, run);
				}

				const lineNo = test.range!.start.line;
				const fileCoverage = coveredLines.get(test.uri!.toString());
				if (fileCoverage) {
					fileCoverage[lineNo]!.executionCount++;
				}

				run.appendOutput(`Completed ${test.id}\r\n`);
			}

			run.end();
		};

		discoverTests(request.include ?? gatherTestItems(ctrl.items)).then(runTestQueue);
	};

	ctrl.refreshHandler = async () => {
		await Promise.all(
			getWorkspaceTestPatterns().map(({ pattern }) => findInitialFiles(ctrl, pattern))
		);
	};

	ctrl.createRunProfile(
		'Run Tests',
		vscode.TestRunProfileKind.Run,
		runHandler,
		true,
		undefined,
		false
	);

	ctrl.resolveHandler = async (item) => {
		if (!item) {
			context.subscriptions.push(...startWatchingWorkspace(ctrl, fileChangedEmitter));
			return;
		}

		const data = testData.get(item);
		if (data instanceof TestFile) {
			await data.updateFromDisk(ctrl, item);
		}
	};

	function updateNodeForDocument(e: vscode.TextDocument) {
		if (e.uri.scheme !== 'file') {
			return;
		}

		if (!e.uri.path.endsWith(fileEnding)) {
			return;
		}

		const { file, data } = getOrCreateFile(ctrl, e.uri);
		data.updateFromContents(ctrl, e.getText(), file);
	}

	for (const document of vscode.workspace.textDocuments) {
		updateNodeForDocument(document);
	}

	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument(updateNodeForDocument),
		vscode.workspace.onDidChangeTextDocument((e) => updateNodeForDocument(e.document))
	);
}

function getOrCreateFile(controller: vscode.TestController, uri: vscode.Uri) {
	const existing = controller.items.get(uri.toString());
	if (existing) {
		return { file: existing, data: testData.get(existing) as TestFile };
	}

	const file = controller.createTestItem(uri.toString(), uri.path.split('/').pop()!, uri);
	controller.items.add(file);

	const data = new TestFile();
	testData.set(file, data);

	file.canResolveChildren = true;
	return { file, data };
}

function gatherTestItems(collection: vscode.TestItemCollection) {
	const items: vscode.TestItem[] = [];
	collection.forEach((item) => items.push(item));
	return items;
}

function getWorkspaceTestPatterns() {
	if (!vscode.workspace.workspaceFolders) {
		return [];
	}

	return vscode.workspace.workspaceFolders.map((workspaceFolder) => ({
		workspaceFolder,
		pattern: new vscode.RelativePattern(workspaceFolder, filePattern),
	}));
}

async function findInitialFiles(
	controller: vscode.TestController,
	pattern: vscode.GlobPattern
) {
	for (const file of await vscode.workspace.findFiles(pattern)) {
		getOrCreateFile(controller, file);
	}
}

function startWatchingWorkspace(
	controller: vscode.TestController,
	fileChangedEmitter: vscode.EventEmitter<vscode.Uri>
) {
	return getWorkspaceTestPatterns().map(({ workspaceFolder, pattern }) => {
		const watcher = vscode.workspace.createFileSystemWatcher(pattern);

		watcher.onDidCreate((uri) => {
			getOrCreateFile(controller, uri);
			fileChangedEmitter.fire(uri);
		});
		watcher.onDidChange(async (uri) => {
			const { file, data } = getOrCreateFile(controller, uri);
			if (data.didResolve) {
				await data.updateFromDisk(controller, file);
			}
			fileChangedEmitter.fire(uri);
		});
		watcher.onDidDelete((uri) => controller.items.delete(uri.toString()));

		findInitialFiles(controller, pattern);

		return watcher;
	});
}
