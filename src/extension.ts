import * as vscode from "vscode";
import {
  getContentFromFilesystem,
  TestCase,
  wingFileFromUri,
  WingFile,
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
    logger.info("refreshHandler triggered");
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
   * Handler that is triggered when the user clicks the expand button in the test explorer.
   */

  testController.resolveHandler = async (item) => {
    if (!item) {
      logger.debug("resolveHandler triggered without item");
      return;
    }

    const data = testFileStore.get(item);
    if (data instanceof WingFile) {
      await data.updateFromDisk(item, testController);
    }
  };

  /**
   * Handler for the "Run" button in the test explorer or test file.
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
   * Initial test discovery.
   */
  context.subscriptions.push(
    ...startWatchingWorkspace(testController, fileChangedEmitter, filePattern)
  );
}

const startTestRun = (
  request: vscode.TestRunRequest,
  testController: vscode.TestController
) => {
  const queue: vscode.TestItem[] = [];
  const testRun = testController.createTestRun(request);
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
        testRun.enqueued(test);
        queue.push(test);
      } else {
        if (data instanceof WingFile && !data.didResolve) {
          // await data.updateFromDisk(test, testC);
        }

        const testItems = gatherTestItems(test.children);
        await discoverTests(testItems);
      }
    }
  };

  const runTestQueue = async () => {
    const exec = async (test: vscode.TestItem) => {
      testRun.appendOutput(`Running ${test.id}\r\n`);
      if (testRun.token.isCancellationRequested) {
        testRun.skipped(test);
      } else {
        testRun.started(test);
        await TestCase.run(test, testRun);
      }

      const lineNo = test.range!.start.line;
      const fileCoverage = coveredLines.get(test.uri!.toString());
      if (fileCoverage) {
        fileCoverage[lineNo]!.executionCount++;
      }

      testRun.appendOutput(`Completed ${test.id}\r\n`);
    };
    await Promise.all(queue.map((testItem) => exec(testItem)));

    testRun.end();
  };

  discoverTests(request.include ?? gatherTestItems(testController.items)).then(
    runTestQueue
  );
};

const runHandler = (
  request: vscode.TestRunRequest2,
  cancellation: vscode.CancellationToken,
  testController: vscode.TestController,
  fileChangedEmitter: vscode.EventEmitter<vscode.Uri>
) => {
  if (!request.continuous) {
    return startTestRun(request, testController);
  }

  const l = fileChangedEmitter.event(async (uri) => {
    const wingFile = wingFileFromUri(uri);
    const { file } = await createTestItemFromFile(testController, wingFile);
    startTestRun(
      new vscode.TestRunRequest2([file], undefined, request.profile, true),
      testController
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

  const workspace = vscode.workspace.getWorkspaceFolder(wingFile.uri);
  if (wingFile.hasTests) {
    const parent = testController.items.get(workspace!.uri.toString());
    if (parent) {
      parent.children.add(vscodeTestItem);
    } else {
      testController.items.add(vscodeTestItem);
    }
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
  for (const { workspaceFolder, pattern } of testFilePatternForWorkspaces) {
    const workspaceTestItem = controller.createTestItem(
      workspaceFolder.uri.toString(),
      workspaceFolder.name,
      workspaceFolder.uri
    );
    workspaceTestItem.canResolveChildren = true;
    controller.items.add(workspaceTestItem);

    findTestFilesInWorkspace(controller, pattern);

    const watcher = vscode.workspace.createFileSystemWatcher(
      pattern,
      false,
      false,
      false
    );

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

    watcher.onDidDelete((uri) => {
      const workspaceItems = controller.items.get(
        workspaceFolder.uri.toString()
      );
      if (!workspaceItems) {
        controller.items.delete(uri.toString());
      } else {
        workspaceItems.children.delete(uri.toString());
      }
    });
    fileWatchers.push(watcher);
  }
  return fileWatchers;
};
