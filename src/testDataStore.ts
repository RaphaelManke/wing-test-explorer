import * as vscode from "vscode";
import { TestHeading, TestCase, WingFile } from "./testTree";

export type WingTestData = TestHeading | TestCase | WingFile;

export const testData = new WeakMap<vscode.TestItem, WingTestData>();
