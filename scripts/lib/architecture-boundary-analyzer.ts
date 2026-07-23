import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import * as ts from 'typescript';

export type SourceInput = {
  path: string;
  content: string;
};

export type FrontendPrivateImport = {
  sourcePath: string;
  targetPath: string;
  importKind: 'type' | 'value';
};

export type RoutePersistenceWrite = {
  sourcePath: string;
  routeSite: string;
  receiver: 'db' | 'tx';
  operation: 'insert' | 'update' | 'delete';
  line: number;
};

export type SemanticAuthorityRule =
  | 'rate-ranking'
  | 'selected-rate-proof-minting'
  | 'label-provider-selection'
  | 'inventory-authority'
  | 'billing-finalization'
  | 'auth-scope-status-lock'
  | 'provider-capability-routing'
  | 'money-authority';

export type FrontendSemanticAuthority = {
  sourcePath: string;
  site: string;
  rule: SemanticAuthorityRule;
  line: number;
};

const FRONTEND_ROOT = 'web/src/';
const BACKEND_ROOT = 'src/';
const PUBLIC_BACKEND_ROOTS = ['src/contracts/', 'src/shared/'] as const;
const SOURCE_EXTENSIONS = /\.(?:ts|tsx)$/;
const WRITE_OPERATIONS = new Set(['insert', 'update', 'delete']);
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

export function normalizeRepoPath(path: string): string {
  return path.split(sep).join('/').replace(/^\.\//, '');
}

export function listSourceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.vite') continue;
      const path = resolve(directory, entry);
      const stats = statSync(path);
      if (stats.isDirectory()) walk(path);
      else if (SOURCE_EXTENSIONS.test(entry) && !entry.endsWith('.d.ts')) files.push(path);
    }
  };
  walk(root);
  return files.sort();
}

export function readSources(root: string): SourceInput[] {
  return listSourceFiles(root).map((absolutePath) => ({
    path: normalizeRepoPath(relative(process.cwd(), absolutePath)),
    content: readFileSync(absolutePath, 'utf8'),
  }));
}

function scriptKind(path: string): ts.ScriptKind {
  return path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function sourceFile(input: SourceInput): ts.SourceFile {
  return ts.createSourceFile(
    input.path,
    input.content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(input.path),
  );
}

export function scanFrontendPrivateImports(
  inputs: SourceInput[],
): FrontendPrivateImport[] {
  const findings: FrontendPrivateImport[] = [];
  for (const input of inputs) {
    const sourcePath = normalizeRepoPath(input.path);
    if (!sourcePath.startsWith(FRONTEND_ROOT)) continue;
    const parsed = sourceFile(input);
    for (const statement of parsed.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (!specifier.startsWith('.')) continue;
      const targetPath = normalizeRepoPath(relative(
        process.cwd(),
        resolve(dirname(resolve(process.cwd(), sourcePath)), specifier),
      ));
      if (!targetPath.startsWith(BACKEND_ROOT)) continue;
      if (PUBLIC_BACKEND_ROOTS.some((root) => targetPath.startsWith(root))) continue;
      findings.push({
        sourcePath,
        targetPath,
        importKind: statement.importClause?.isTypeOnly ? 'type' : 'value',
      });
    }
  }
  return findings.sort((left, right) => (
    left.sourcePath.localeCompare(right.sourcePath) ||
    left.targetPath.localeCompare(right.targetPath)
  ));
}

type RouteContext = {
  method: string;
  path: string;
};

function routeContextFor(node: ts.Node): RouteContext | null {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return null;
  const owner = node.expression.expression;
  const method = node.expression.name.text;
  const path = node.arguments[0];
  if (!ts.isIdentifier(owner) || owner.text !== 'app' || !ROUTE_METHODS.has(method)) return null;
  if (!path || !ts.isStringLiteralLike(path)) return null;
  return { method: method.toUpperCase(), path: path.text };
}

export function scanRoutePersistenceWrites(
  inputs: SourceInput[],
): RoutePersistenceWrite[] {
  const findings: RoutePersistenceWrite[] = [];
  for (const input of inputs) {
    const sourcePath = normalizeRepoPath(input.path);
    if (!sourcePath.startsWith('src/routes/')) continue;
    const parsed = sourceFile(input);
    const visit = (node: ts.Node, route: RouteContext | null): void => {
      const nestedRoute = routeContextFor(node) ?? route;
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const receiver = node.expression.expression;
        const operation = node.expression.name.text;
        if (
          ts.isIdentifier(receiver) &&
          (receiver.text === 'db' || receiver.text === 'tx') &&
          WRITE_OPERATIONS.has(operation)
        ) {
          const line = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
          findings.push({
            sourcePath,
            routeSite: nestedRoute ? `${nestedRoute.method} ${nestedRoute.path}` : '<module-scope>',
            receiver: receiver.text,
            operation: operation as RoutePersistenceWrite['operation'],
            line,
          });
        }
      }
      ts.forEachChild(node, (child) => visit(child, nestedRoute));
    };
    visit(parsed, null);
  }
  return findings.sort((left, right) => (
    left.sourcePath.localeCompare(right.sourcePath) || left.line - right.line
  ));
}

type SemanticFeatures = {
  words: Set<string>;
  proofFields: Set<string>;
  hasMutation: boolean;
  hasHashing: boolean;
  hasRateRankingExpression: boolean;
  hasProviderSelection: boolean;
  hasInventoryArithmetic: boolean;
  hasBillingReduction: boolean;
  hasScopeThrowGate: boolean;
  hasProviderCapabilityRouting: boolean;
  hasAuthoritativeMoneyComputation: boolean;
};

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ||
    ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function callName(call: ts.CallExpression): string {
  if (ts.isIdentifier(call.expression)) return call.expression.text.toLowerCase();
  if (ts.isPropertyAccessExpression(call.expression)) return call.expression.name.text.toLowerCase();
  return '';
}

function siteName(node: ts.FunctionLikeDeclaration, source: ts.SourceFile): string | null {
  if ('name' in node && node.name && ts.isIdentifier(node.name)) return node.name.text;
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyAssignment(parent)) return parent.name.getText(source);
  return null;
}

const proofFieldNames = new Set([
  'ratequoteid',
  'selectedratekey',
  'requestfingerprint',
  'proofsource',
  'selectionref',
]);

function semanticFeatures(root: ts.FunctionLikeDeclaration): SemanticFeatures {
  const features: SemanticFeatures = {
    words: new Set(),
    proofFields: new Set(),
    hasMutation: false,
    hasHashing: false,
    hasRateRankingExpression: false,
    hasProviderSelection: false,
    hasInventoryArithmetic: false,
    hasBillingReduction: false,
    hasScopeThrowGate: false,
    hasProviderCapabilityRouting: false,
    hasAuthoritativeMoneyComputation: false,
  };
  const text = (node: ts.Node): string => node.getText().toLowerCase();
  const isArithmetic = (node: ts.BinaryExpression): boolean => [
    ts.SyntaxKind.PlusToken,
    ts.SyntaxKind.MinusToken,
    ts.SyntaxKind.AsteriskToken,
    ts.SyntaxKind.SlashToken,
    ts.SyntaxKind.PercentToken,
  ].includes(node.operatorToken.kind);
  const isComparison = (node: ts.BinaryExpression): boolean => [
    ts.SyntaxKind.LessThanToken,
    ts.SyntaxKind.LessThanEqualsToken,
    ts.SyntaxKind.GreaterThanToken,
    ts.SyntaxKind.GreaterThanEqualsToken,
  ].includes(node.operatorToken.kind);
  const subtreeHas = (node: ts.Node, predicate: (candidate: ts.Node) => boolean): boolean => {
    let found = false;
    const scan = (candidate: ts.Node): void => {
      if (found) return;
      if (predicate(candidate)) {
        found = true;
        return;
      }
      ts.forEachChild(candidate, scan);
    };
    scan(node);
    return found;
  };
  const assignedName = (node: ts.Expression): string => {
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent)) return parent.name.getText().toLowerCase();
    if (ts.isPropertyAssignment(parent)) return parent.name.getText().toLowerCase();
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return parent.left.getText().toLowerCase();
    }
    return '';
  };
  const visit = (node: ts.Node): void => {
    if (node !== root && isFunctionLike(node)) return;
    if (ts.isIdentifier(node)) {
      const word = node.text.toLowerCase();
      features.words.add(word);
      if (proofFieldNames.has(word)) features.proofFields.add(word);
    } else if (ts.isStringLiteralLike(node)) {
      for (const word of node.text.toLowerCase().split(/[^a-z0-9]+/)) {
        if (word) features.words.add(word);
      }
    } else if (ts.isBinaryExpression(node) && isArithmetic(node)) {
      const expressionText = text(node);
      if (/inventory|stock|quantity|qty/.test(expressionText)) features.hasInventoryArithmetic = true;
      if (
        /money|amount|total|price|cost|markup|margin|charge|rate/.test(expressionText) &&
        /best|winner|selected|official|final|charge|total|markup|margin/.test(assignedName(node))
      ) features.hasAuthoritativeMoneyComputation = true;
    } else if (ts.isConditionalExpression(node) || ts.isIfStatement(node) || ts.isSwitchStatement(node)) {
      const selectionText = text(node);
      if (/provider|carrier/.test(selectionText)) features.hasProviderSelection = true;
      if (
        /provider|carrier|store/.test(selectionText) &&
        /capability|eligible|eligibility|supported|route/.test(selectionText)
      ) features.hasProviderCapabilityRouting = true;
      if (
        ts.isIfStatement(node) &&
        /role|auth|scope|permission|clientid|storeid|orderstatus|lockedstatus/.test(text(node.expression)) &&
        subtreeHas(node.thenStatement, ts.isThrowStatement)
      ) features.hasScopeThrowGate = true;
    } else if (ts.isCallExpression(node)) {
      const name = callName(node);
      if (/^(create|update|delete|save|finalize|purchase|buy|post|put|patch|mutate|enqueue|sync)/.test(name)) {
        features.hasMutation = true;
      }
      if (/hash|digest|fingerprint/.test(name)) features.hasHashing = true;
      if (name === 'reduce') {
        const reductionText = text(node);
        if (
          /rate|quote|amount|total|price|cost/.test(reductionText) &&
          subtreeHas(node, (candidate) => ts.isBinaryExpression(candidate) && isComparison(candidate))
        ) features.hasRateRankingExpression = true;
        if (/amount|total|price|cost|markup|margin/.test(reductionText)) {
          features.hasBillingReduction = true;
        }
        if (
          /money|amount|total|price|cost|markup|margin|charge|rate/.test(reductionText) &&
          /best|winner|selected|official|final|charge|total|markup|margin/.test(assignedName(node))
        ) features.hasAuthoritativeMoneyComputation = true;
      }
      if (name === 'fetch') {
        const callText = node.getText().toLowerCase();
        if (/method\s*:\s*['\"](?:post|put|patch|delete)['\"]/.test(callText)) features.hasMutation = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return features;
}

function mentions(features: SemanticFeatures, pattern: RegExp): boolean {
  return [...features.words].some((word) => pattern.test(word));
}

function rulesFor(features: SemanticFeatures): SemanticAuthorityRule[] {
  const rules: SemanticAuthorityRule[] = [];
  const rate = mentions(features, /rate|quote/);
  const money = mentions(features, /money|amount|total|price|cost|markup|margin|charge/);
  const label = mentions(features, /label|postage/);
  const provider = mentions(features, /provider|carrier|servicecode|store/);
  const inventory = mentions(features, /inventory|stock|quantity|qty/);
  const billing = mentions(features, /billing|invoice|finalize|finalization/);
  const scope = mentions(features, /role|auth|scope|permission|clientid|storeid|orderstatus|lockedstatus/);

  if (rate && money && features.hasRateRankingExpression) rules.push('rate-ranking');
  if (features.proofFields.size >= 2 && features.hasHashing) rules.push('selected-rate-proof-minting');
  if (label && provider && features.hasProviderSelection && features.hasMutation) rules.push('label-provider-selection');
  if (inventory && features.hasInventoryArithmetic && features.hasMutation) rules.push('inventory-authority');
  if (billing && money && features.hasBillingReduction && features.hasMutation) rules.push('billing-finalization');
  if (scope && features.hasScopeThrowGate && features.hasMutation) rules.push('auth-scope-status-lock');
  if (provider && features.hasProviderCapabilityRouting) rules.push('provider-capability-routing');
  if (money && features.hasAuthoritativeMoneyComputation && features.hasMutation) rules.push('money-authority');
  return rules;
}

export function scanFrontendSemanticAuthority(
  inputs: SourceInput[],
): FrontendSemanticAuthority[] {
  const findings: FrontendSemanticAuthority[] = [];
  for (const input of inputs) {
    const sourcePath = normalizeRepoPath(input.path);
    if (!sourcePath.startsWith(FRONTEND_ROOT)) continue;
    const parsed = sourceFile(input);
    const visit = (node: ts.Node): void => {
      if (isFunctionLike(node)) {
        const site = siteName(node, parsed);
        if (!site) {
          ts.forEachChild(node, visit);
          return;
        }
        const features = semanticFeatures(node);
        const line = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
        for (const rule of rulesFor(features)) {
          findings.push({ sourcePath, site, rule, line });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
  }
  const seen = new Set<string>();
  return findings
    .filter((finding) => {
      const key = `${finding.sourcePath}:${finding.site}:${finding.rule}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => (
      left.sourcePath.localeCompare(right.sourcePath) || left.line - right.line || left.rule.localeCompare(right.rule)
    ));
}

export function functionCalls(
  input: SourceInput,
  functionName: string,
  includeNested = false,
): Set<string> {
  const parsed = sourceFile(input);
  const calls = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node) && siteName(node, parsed) === functionName) {
      const scan = (child: ts.Node): void => {
        if (!includeNested && child !== node && isFunctionLike(child)) return;
        if (ts.isCallExpression(child)) calls.add(callName(child));
        ts.forEachChild(child, scan);
      };
      scan(node);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return calls;
}
