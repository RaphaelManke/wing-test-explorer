import { TextDecoder } from "util";
import * as vscode from "vscode";
import { parseMarkdown, parseWingFile } from "./parser";
import { exec, execSync } from "child_process";
import { testData } from "./testDataStore";

const textDecoder = new TextDecoder("utf-8");

let generationCounter = 0;

export const getContentFromFilesystem = async (uri: vscode.Uri) => {
  try {
    const rawContent = await vscode.workspace.fs.readFile(uri);
    return textDecoder.decode(rawContent);
  } catch (e) {
    console.warn(`Error providing tests for ${uri.fsPath}`, e);
    return "";
  }
};

export const wingFileFromUri = (uri: vscode.Uri) => {
  const label = uri.path.split("/").pop()!;
  return new WingFile(uri.toString(), label, uri);
};

export const wingFileFromTextDocument = (
  textDocument: vscode.TextDocument,
  fileEnding: string
) => {
  if (textDocument.uri.scheme !== "file") {
    return;
  }

  if (!textDocument.uri.path.endsWith(fileEnding)) {
    return;
  }
  return wingFileFromUri(textDocument.uri);
};
export class WingFile {
  public hasTests = true;
  public didResolve = false;

  constructor(
    public id: string,
    public label: string,
    public uri: vscode.Uri
  ) {}

  public async updateFromDisk(
    testItem: vscode.TestItem,
    controller: vscode.TestController
  ) {
    if (this.didResolve) {
      return;
    }
    try {
      const content = await getContentFromFilesystem(this.uri);
      testItem.error = undefined;
      this.updateFromContents(content, testItem, controller);
    } catch (e) {
      testItem.error = (e as Error).stack;
    }
  }
  private getContent() {
    return getContentFromFilesystem(this.uri);
  }
  private async getTests(content: string) {
    return parseWingFile(content);
  }

  public async updateFromContents(
    content: string,
    item: vscode.TestItem,
    controller: vscode.TestController
  ) {
    const thisGeneration = generationCounter++;
    this.didResolve = true;

    const testCases = await this.getTests(content);
    if (testCases.length === 0) {
      this.hasTests = false;
    }

    for (const testCase of testCases) {
      const id = `${item.uri}/${testCase.name}`;
      const testItem = controller.createTestItem(id, testCase.name, item.uri);
      testItem.canResolveChildren = false;
      testItem.range = testCase.range;
      testData.set(testItem, new TestCase(thisGeneration));
      item.children.add(testItem);
    }
  }
}

// export class PossibleTestFile {
//   public didResolve = false;

//   public async updateFromDisk(
//     controller: vscode.TestController,
//     item: vscode.TestItem
//   ) {
//     try {
//       const content = await getContentFromFilesystem(item.uri!);
//       item.error = undefined;
//       this.updateFromContents(controller, content, item);
//     } catch (e) {
//       item.error = (e as Error).stack;
//     }
//   }

//   /**
//    * Parses the tests from the input text, and updates the tests contained
//    * by this file to be those from the text,
//    */
//   public updateFromContents(content: string, item: vscode.TestItem) {
//     const ancestors = [{ item, children: [] as vscode.TestItem[] }];
//     const thisGeneration = generationCounter++;
//     this.didResolve = true;

//     const ascend = (depth: number) => {
//       while (ancestors.length > depth) {
//         const finished = ancestors.pop()!;
//         finished.item.children.replace(finished.children);
//       }
//     };

//     const testCases = parseWingFile(content);

//     for (const testCase of testCases) {
//       const id = `${item.uri}/${testCase.name}`;
//       const testItem = controller.createTestItem(id, testCase.name, item.uri);
//       testItem.range = testCase.range;
//       testData.set(testItem, new TestCase(thisGeneration));
// 	  if (item instanceof vscode) {
//       item.children.push(testItem);
//     }
//     // onHeading: (range, name, depth) => {
//     //     ascend(depth);
//     //     const parent = ancestors[ancestors.length - 1];
//     //     const id = `${item.uri}/${name}`;

//     //     const thead = controller.createTestItem(id, name, item.uri);
//     //     thead.range = range;
//     //     testData.set(thead, new TestCase(thisGeneration));
//     //     parent.children.push(thead);
//     //     // ancestors.push({ item: thead, children: [] });
//     //   },

//     ascend(0); // finish and assign children for all remaining items
//   }
// }

export class TestHeading {
  constructor(public generation: number) {}
}

type Operator = "+" | "-" | "*" | "/";

const cache = new Map<string, string>();
export class TestCase {
  constructor(public generation: number) {}

  static async run(
    testItem: vscode.TestItem,
    testRun: vscode.TestRun
  ): Promise<void> {
    const result = { success: "", error: "" };
    const exe = await executeShellCommandPromise(
      `wing test ${testItem.uri!.fsPath}`
    );
    if (exe.success) {
      result.success = exe.message;
    } else {
      result.error = extractFailureMessage(exe.error) || exe.error;
      console.log(parseInput(exe.error));
    }

    const duration = exe.duration;

    if (exe.success) {
      testRun.passed(testItem, duration);
    } else {
      const message = vscode.TestMessage.diff(
        `Expected ${testItem.label}`,
        String("Assertion matches"),
        String(result.error)
      );
      message.location = new vscode.Location(testItem.uri!, testItem.range!);
      const errorPerTest = parseInput(exe.error);
      if (errorPerTest[testItem.label] === "pass") {
        testRun.passed(testItem, duration);
      } else {
        testRun.failed(testItem, message, duration);
      }
    }
  }

  private evaluate() {
    return true;
  }
}

const executeShellCommandPromise = (
  command: string
): Promise<
  | { success: true; message: string; duration: number }
  | { success: false; error: string; duration: number }
> => {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.warn(error);
        const duration = Date.now() - start;
        resolve({ success: false, error: stderr ? stderr : stdout, duration });
      }
      const duration = Date.now() - start;
      resolve({ success: true, message: stdout ? stdout : stderr, duration });
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
