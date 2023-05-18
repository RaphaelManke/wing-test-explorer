import * as vscode from 'vscode';

const testRe = /^([0-9]+)\s*([+*/-])\s*([0-9]+)\s*=\s*([0-9]+)/;
const headingRe = /^(#+)\s*(.+)$/;

export const parseMarkdown = (
	text: string,
	events: {
		onTest(
			range: vscode.Range,
			a: number,
			operator: string,
			b: number,
			expected: number
		): void;
		onHeading(range: vscode.Range, name: string, depth: number): void;
	}
) => {
	const lines = text.split('\n');

	for (let lineNo = 0; lineNo < lines.length; lineNo++) {
		const line = lines[lineNo];
		const test = testRe.exec(line);
		if (test) {
			const [, a, operator, b, expected] = test;
			const range = new vscode.Range(
				new vscode.Position(lineNo, 0),
				new vscode.Position(lineNo, test[0].length)
			);
			events.onTest(range, Number(a), operator, Number(b), Number(expected));
			continue;
		}

		const heading = headingRe.exec(line);
		if (heading) {
			const [, pounds, name] = heading;
			const range = new vscode.Range(
				new vscode.Position(lineNo, 0),
				new vscode.Position(lineNo, line.length)
			);
			events.onHeading(range, name, pounds.length);
		}
	}
};

export const parseWingFile = (
	text: string,
	events: {
		onTest(
			range: vscode.Range,
			a: number,
			operator: string,
			b: number,
			expected: number
		): void;
		onHeading(range: vscode.Range, name: string, depth: number): void;
	}
) => {
	// Regex pattern to match the desired strings
	const regexPattern = /test "([^"]+)" \{[^}]+\}/g;

	// Array to store the matched strings and their line information
	const matchesWithLines: { value: string; lineNumber: number; lineLength: number }[] =
		[];
	let match: RegExpExecArray | null;

	// Finding matches and their line information
	const lines: string[] = text.split('\n');

	while ((match = regexPattern.exec(text)) !== null) {
		if (match == null) {
			continue;
		}
		const matchValue = match[1];
		const lineNumber = lines.findIndex((line) =>
			// eslint-disable-next-line @typescript-eslint/ban-ts-comment
			// @ts-ignore
			line.includes(matchValue)
		);
		const lineLength = lines[lineNumber].length;
		matchesWithLines.push({ value: matchValue, lineNumber, lineLength });
		const [, pounds, name] = match;
		const range = new vscode.Range(
			new vscode.Position(lineNumber, 0),
			new vscode.Position(lineNumber, lineLength)
		);
		events.onHeading(range, pounds, pounds.length);
	}
};
