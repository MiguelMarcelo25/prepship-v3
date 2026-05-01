export interface PackageDimension {
  length: number;
  width: number;
  height: number;
  label: string;
}

export interface ParsedPackageDimensions {
  dimensions: PackageDimension[];
  skippedLines: string[];
  duplicateCount: number;
  rawLineCount: number;
}

export const STANDARD_PACKAGE_DIMENSIONS_RAW = `
10.5x7.5x5.5
10.5x7.5x5
10.5x8.5x5.5
10.5x8.5x5
10x10x5
10x7x4
10x8x5
10x10x1
10x10x9
10x5x1
10x6x1
10x6x3
10x6x5
10x6x6
10x7x5
10x8x2
10x8x3
10x8x4
10x8x6
10x8x8
10x9x1
10x9x7
11x8x6
11x9x6
11x10.5x8
11x10
11x10.5x8.5
11x10.5x8
11x10x3
11x10x7
11x10x9
11x11x1
11x11x5
11x11x6
11x11x8
11x6x1
11x7x2
11x8.5x5.5
11x8.5x5
11x8x5
11x9x7
12.5x10x8.5
12.5x10x8
12.5x7x5
12
12x10x3
12x12x6
12x8x6
12x10x2
12x10x6
12x10x7
12x10x8
12x11.5x5.5
12x11.5x5
12x11x10
12x11x11
12x11x5
12x11x5.5
12x11x5
12x11x6
12x11x8
12x11x9
12x12x1
12x12x11
12x12x12
12x12x2
12x12x3
12x12x4
12x12x5
12x12x8
12x12x9
12x6x1
12x6x2
12x8x1
12x8x2
12x8x4
12x8x8
12x9x3
12x9x4.5
12x9x4
12x9x5
12x9x6
12x9x6.5
12x9x6
12x9x7
12x9x9
13x10.5x8
13x10
13x10x3
13x10x8
13x11x8
13x12x10
13x12x11
13x12x5.5
13x12x5
13x12x6
13x13x1
13x13x11
13x6x2
13x7x5
13x7x6
13x8x5
13x9x6
14.5x7.5x5
14.5x7
14x10x10
14x10x3
14x10x8
14x10x8.5
14x10x8
14x10x9
14x11x10
14x11x7
14x12x10
14x12x2
14x12x8
14x13x1
14x13x2
14x14x10
14x14x11
14x14x12
14x14x13
14x14x4
14x14x6
14x8x3
14x8x6
14x9x6
15x10x6
15x10x9
15x12x10
15x12x11
15x12x3
15x12x4
15x12x6
15x13x10
15x13x12
15x13x6
15x13x8
15x14.5x7
15x14
15x14x10
15x14x8
15x15x12
15x15x6
15x6x5
15x6x6
15x9x4
16.5x16x12
16
16x10x3
16x10x6
16x10x8
16x11.5x8
16x11
16x11x11
16x11x2
16x11x3
16x11x6
16x11x8
16x12x10
16x12x11
16x12x4
16x12x4.5
16x12x4
16x12x5
16x12x6
16x12x7
16x12x8
16x13x10
16x13x12
16x13x3
16x13x8
16x13x9
16x14x3
16x16x7
17.5x13.5x8.5
17.5x13.5x8
17.5x13x13
17
17.5x14x8
17
17.5x16x12
17
17x9x13
17x10x3
17x10x4
17x11.5x8
17x11
17x12x11
17x13x5
17x13x7.5
17x13x7
17x13x8
17x13x9
17x14x10
17x14x11
17x14x13
17x14x8
17x16x12
17x8x6
18x11x3.5
18x11x3
18x10x3
18x11x8
18x12x10
18x12x12
18x12x5
18x12x6
18x12x7
18x12x8
18x13.5x8.5
18x13.5x8
18x13x3
18x13x5
18x13x5.5
18x13x5
18x13x6
18x13x8
18x14x10
18x14x11
18x14x4
18x14x6
18x14x8
18x15x12.5
18x15x12
18x15x2
18x16x12
18x16x13
18x16x16
18x17x9
18x18x12
18x5x5
19x10x7.5
19x10x7
19x11x8
19x12x6
19x12x6.5
19x12x6
19x12x7
19x13.5x8
19x13
19x14x14
19x14x8
19x15x10
19x15x8
19x16x14
19x16x3
19x17x14
19x18x17
1x1x1
20.5x5.5x5.5
20.5x5.5x5
20x11x4
20x12x4
20x12x6
20x14x12
20x14x14
20x15x10
20x16x6
20x16x8
20x17x11
20x19.5x15
20x19
20x20x10
20x20x11
20x20x12
20x20x6
21x11x9
21x13x3
21x13x6
21x14x13
21x15x12
21x16x8
21x17x10
21x17x12
21x18.5x12
21x18
21x18x15
22x11x8
22x16x11
22x16x12
22x16x8
22x18x12
22x19x11
23.5x14x14
23
23.5x14x4.5
23.5x14x4
23x10x3
23x15x10
23x15x6
23x16x6
23x17x14
24x11x6
24x12x12
24x14x12
24x14x7
24x16x6
24x18x10
24x18x18
24x21x20
24x24x10
24x24x12
25x13.5x11
25x13
25x21x15
25x21x20
26.5x13.5x12
26.5x13
26.5x14x12
26
26x20x12
26x20x15
26x20x16
26x21x16
27x14x12
27x23x10
27x27x7
28x27x7
29x12x8
2x2x2
3.5x3.5x3.5
3.5x3.5x3
30x14x13
31x21x11
32x20x19
33x20x19
36x19x4
36x22x14
38x12x10
45x14x12
46x15x12
47x11x8
4x3x2
4x4x2
4x4x3
5.5x3x3
5
5.5x5x4
5
5x3x1
5x3x3
5x4x3
66x39x27
6x3.5x3.5
6x3.5x3
6x3x3
6x6x1
6x6x2
6x6x3
6x6x4
6x6x6
7.2x4.1x3.5
7.2x4.1x3
7.5x5x3
7
7x5x5
7x6x1
7x6x5.5
7x6x5
7x6x6
7x7x5
7x7x6
7x7x7
8x4x4
8x6x3
8x6x6
8x8x1
8x8x6
8x8x7
8x8x8
9.5x5.5x3.5
9.5x5.5x3
9.5x7.2x5
9.5x7
9x5x2
9x6x1
9x6x3
9x6x6
9x7x1
9x7x5.5
9x7x5
9x7x7
9x8x2
9x8x5
9x8x7
9x9x9
9x9x9"
`;

export function formatDimensionNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(value).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

export function formatPackageDimensionLabel(input: {
  length: number;
  width: number;
  height: number;
}): string {
  return [
    formatDimensionNumber(input.length),
    formatDimensionNumber(input.width),
    formatDimensionNumber(input.height),
  ].join('x');
}

function parseDimensionPart(value: string): number | null {
  const cleaned = value.trim().replace(/["',]/g, '');
  if (!cleaned) return null;
  const parsed = Number.parseFloat(cleaned);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed * 100) / 100;
}

export function parsePackageDimensionLines(raw: string): ParsedPackageDimensions {
  const dimensions: PackageDimension[] = [];
  const skippedLines: string[] = [];
  const seen = new Set<string>();
  let duplicateCount = 0;
  let rawLineCount = 0;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    rawLineCount += 1;

    const parts = trimmed.split(/[xX*\u00d7]/).map((part) => part.trim());
    if (parts.length !== 3) {
      skippedLines.push(trimmed);
      continue;
    }

    const parsed = parts.map(parseDimensionPart);
    if (parsed.some((value) => value == null)) {
      skippedLines.push(trimmed);
      continue;
    }

    const [length, width, height] = parsed as [number, number, number];
    const label = formatPackageDimensionLabel({ length, width, height });
    if (seen.has(label)) {
      duplicateCount += 1;
      continue;
    }

    seen.add(label);
    dimensions.push({ length, width, height, label });
  }

  return {
    dimensions,
    skippedLines,
    duplicateCount,
    rawLineCount,
  };
}

export const STANDARD_PACKAGE_DIMENSIONS_PARSE_RESULT =
  parsePackageDimensionLines(STANDARD_PACKAGE_DIMENSIONS_RAW);

export const STANDARD_PACKAGE_DIMENSIONS =
  STANDARD_PACKAGE_DIMENSIONS_PARSE_RESULT.dimensions;
