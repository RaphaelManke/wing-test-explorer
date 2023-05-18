import * as vscode from "vscode";
import {
  getContentFromFilesystem,
  TestCase,
  wingFileFromUri,
  WingFile,
  wingFileFromTextDocument,
} from "./testTree";
import { testData as testFileStore } from "./testDataStore";

interface WingExtensionSettings {
  logLevel: "warn" | "info" | "debug";
  fileEnding: string;
}

const getConfig = (name: keyof WingExtensionSettings) => {
  return vscode.workspace
    .getConfiguration("wing.test")
    .get(name) as WingExtensionSettings[keyof WingExtensionSettings];
};

const getLogger = () => {
  const logLevel = getConfig("logLevel");
  return {
    info: console.log,
    warn: console.warn,
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    debug: logLevel === "debug" ? console.debug : () => {},
    error: console.error,
  };
};

export async function activate(context: vscode.ExtensionContext) {
  const logger = getLogger();
  const fileEnding = getConfig("fileEnding");
  const filePattern = `**/*${fileEnding}`;

  logger.debug("Wing extension activated");
  const testController = vscode.tests.createTestController(
    "wingTestController",
    "Wing Tests"
  );
  context.subscriptions.push(testController);

  const fileChangedEmitter: vscode.EventEmitter<vscode.Uri> =
    new vscode.EventEmitter<vscode.Uri>();

  /**
   * Shows a refresh button in the test explorer.
   * This is useful if your tests are not discovered automatically.
   * A refresh run scans the workspace for tests again.
   */
  testController.refreshHandler = async () => {
    logger.debug("refreshHandler triggered");
    const workspacesTestFilePattern =
      getTestFilePatternForWorkspaces(filePattern);
    logger.debug(
      `found ${
        workspacesTestFilePattern.length
      } workspaces, ${workspacesTestFilePattern.map(
        ({ workspaceFolder }) => workspaceFolder.name
      )}`
    );

    await Promise.all(
      workspacesTestFilePattern.map(({ pattern }) =>
        findTestFilesInWorkspace(testController, pattern)
      )
    );
  };

  /**
   * This is the handler for the "Run" button in the test explorer or test file.
   */
  testController.createRunProfile(
    "Run Tests",
    vscode.TestRunProfileKind.Run,
    (request, cancelToken) =>
      runHandler(request, cancelToken, testController, fileChangedEmitter),
    true,
    undefined,
    false
  );

  /**
   * This is the handler that is triggered when the user clicks the expand button in the test explorer.
   */

  testController.resolveHandler = async (item) => {
    if (!item) {
      context.subscriptions.push(
        ...startWatchingWorkspace(
          testController,
          fileChangedEmitter,
          filePattern
        )
      );
      return;
    }

    const data = testFileStore.get(item);
    if (data instanceof WingFile) {
      await data.updateFromDisk(item, testController);
    }
  };

  const matchingFiles = await vscode.workspace.findFiles(filePattern);
  const existingWingFiles = matchingFiles.map((file) => wingFileFromUri(file));
  for (const wingFile of existingWingFiles) {
    createTestItemFromFile(testController, wingFile);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((possibleWingFile) => {
      const wingFile = wingFileFromTextDocument(possibleWingFile, fileEnding);
      if (wingFile) {
        createTestItemFromFile(testController, wingFile);
      }
    }),
    vscode.workspace.onDidChangeTextDocument((possibleWingFile) => {
      const wingFile = wingFileFromTextDocument(
        possibleWingFile.document,
        fileEnding
      );
      if (wingFile) {
        createTestItemFromFile(testController, wingFile);
      }
    })
  );
}

const startTestRun = (
  request: vscode.TestRunRequest,
  ctrl: vscode.TestController
) => {
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

      const data = testFileStore.get(test);
      if (data instanceof TestCase) {
        run.enqueued(test);
        queue.push({ test, data });
      } else {
        if (data instanceof WingFile && !data.didResolve) {
          // await data.updateFromDisk(test, testC);
        }

        const testItems = gatherTestItems(test.children);
        await discoverTests(testItems);
      }

      if (test.uri && !coveredLines.has(test.uri.toString())) {
        try {
          const lines = (await getContentFromFilesystem(test.uri)).split("\n");
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
    const exec = async (test: vscode.TestItem, data: TestCase) => {
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
    };
    await Promise.all(queue.map(({ test, data }) => exec(test, data)));

    run.end();
  };

  discoverTests(request.include ?? gatherTestItems(ctrl.items)).then(
    runTestQueue
  );
};

const runHandler = (
  request: vscode.TestRunRequest2,
  cancellation: vscode.CancellationToken,
  ctrl: vscode.TestController,
  fileChangedEmitter: vscode.EventEmitter<vscode.Uri>
) => {
  if (!request.continuous) {
    return startTestRun(request, ctrl);
  }

  const l = fileChangedEmitter.event(async (uri) => {
    const wingFile = wingFileFromUri(uri);
    const { file } = await createTestItemFromFile(ctrl, wingFile);
    startTestRun(
      new vscode.TestRunRequest2([file], undefined, request.profile, true),
      ctrl
    );
  });
  cancellation.onCancellationRequested(() => l.dispose());
};
const logger = getLogger();
const createTestItemFromFile = async (
  testController: vscode.TestController,
  wingFile: WingFile
) => {
  const vscodeTestItem: vscode.TestItem = testController.createTestItem(
    wingFile.id,
    wingFile.label,
    wingFile.uri
  );
  await wingFile.updateFromDisk(vscodeTestItem, testController);

  if (wingFile.hasTests) {
    testController.items.add(vscodeTestItem);
  } else {
    testController.items.delete(vscodeTestItem.id);
  }
  testFileStore.set(vscodeTestItem, wingFile);

  vscodeTestItem.canResolveChildren = wingFile.hasTests;
  return { file: vscodeTestItem, data: wingFile };
};

const gatherTestItems = (collection: vscode.TestItemCollection) => {
  const items: vscode.TestItem[] = [];
  collection.forEach((item) => items.push(item));
  return items;
};

const getTestFilePatternForWorkspaces = (filePattern: string) => {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    return [];
  }

  const workspaceTestFilePattern = [];
  for (const workspaceFolder of workspaceFolders) {
    workspaceTestFilePattern.push({
      workspaceFolder,
      pattern: new vscode.RelativePattern(workspaceFolder, filePattern),
    });
  }

  return workspaceTestFilePattern;
};

async function findTestFilesInWorkspace(
  controller: vscode.TestController,
  pattern: vscode.GlobPattern
) {
  const filesInWorkspaceMatchingPattern = await vscode.workspace.findFiles(
    pattern
  );
  for (const file of filesInWorkspaceMatchingPattern) {
    const wingFile = wingFileFromUri(file);
    createTestItemFromFile(controller, wingFile);
  }
}

const startWatchingWorkspace = (
  controller: vscode.TestController,
  fileChangedEmitter: vscode.EventEmitter<vscode.Uri>,
  filePattern: string
) => {
  const testFilePatternForWorkspaces =
    getTestFilePatternForWorkspaces(filePattern);
  const fileWatchers: vscode.FileSystemWatcher[] = [];
  for (const { pattern } of testFilePatternForWorkspaces) {
    findTestFilesInWorkspace(controller, pattern);

    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    watcher.onDidCreate((uri) => {
      const wingFile = wingFileFromUri(uri);
      createTestItemFromFile(controller, wingFile);
      fileChangedEmitter.fire(uri);
    });

    watcher.onDidChange(async (uri) => {
      const wingFile = wingFileFromUri(uri);
      const { file, data } = await createTestItemFromFile(controller, wingFile);
      if (data.didResolve) {
        await data.updateFromDisk(file, controller);
      }
      fileChangedEmitter.fire(uri);
    });
    watcher.onDidDelete((uri) => controller.items.delete(uri.toString()));

    fileWatchers.push(watcher);
  }
  return fileWatchers;
};
