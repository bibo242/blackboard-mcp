import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getClient, guard, text, table, when, clip, section, relativeDue } from './helpers.js';
import {
  courseLabel, type BbGrade, type BbGradeColumn, type BbGradeSchema, type Paged,
} from '../client/index.js';
import { htmlToText } from '../lib/extract.js';
import { fmtBytes } from '../lib/files.js';

/** Best display string for a grade cell, across the several shapes it takes. */
function gradeText(g: BbGrade, possible: number | undefined): string {
  const score = g.effectiveScore ?? g.manualScore ?? g.displayGrade?.score;
  const max = possible ?? g.pointsPossible ?? g.displayGrade?.possible;
  if (g.isExempt) return 'exempt';
  if (score === undefined) {
    if (g.status === 'NEEDS_GRADING') return 'awaiting grade';
    return g.displayGrade?.text ?? g.manualGrade ?? '-';
  }
  const pct = max ? ` (${Math.round((score / max) * 100)}%)` : '';
  return max !== undefined ? `${score}/${max}${pct}` : String(score);
}

function columnName(c: BbGradeColumn | undefined): string {
  return c?.effectiveColumnName ?? c?.columnName ?? c?.id ?? '';
}

/**
 * Maps a score onto the course's displayed grade (e.g. "B+").
 *
 * Blackboard stores the numeric score and the schema separately, so a raw
 * score alone cannot tell a student whether they passed. The same 65 is a
 * distinction on one schema and a fail on another.
 */
function letterGrade(
  schema: BbGradeSchema | undefined,
  score: number | undefined,
  possible: number | undefined,
): string | undefined {
  if (!schema?.symbols?.length || score === undefined || !possible) return undefined;
  const pct = (score / possible) * 100;
  for (const sym of schema.symbols) {
    const lo = sym.lowerBound;
    const hi = sym.upperBound;
    if (lo === undefined && hi === undefined) continue;
    const aboveLo = lo === undefined || pct >= lo;
    const belowHi = hi === undefined || pct < hi;
    if (aboveLo && belowHi) return sym.text;
  }
  return undefined;
}

export function registerGradeTools(server: McpServer): void {
  server.registerTool(
    'bb_list_grades',
    {
      title: 'List Blackboard grades',
      description:
        'Lists grades for one course, or across every enrolled course when courseId is omitted. Shows each graded item, the score out of its total, and its status. Cross-course mode uses Blackboard\'s batch API so it costs roughly one request rather than one per course.',
      inputSchema: {
        courseId: z
          .string()
          .optional()
          .describe('Course id, e.g. "_12345_1". Omit for every enrolled course.'),
        gradedOnly: z.boolean().optional().describe('Hide items with no score yet. Default false.'),
        maxCourses: z
          .number()
          .int()
          .min(1)
          .max(40)
          .optional()
          .describe('Cap courses in cross-course mode. Default 15.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_list_grades', async (args) => {
      const client = await getClient();
      const userId = await client.selfId();

      // ── single course ──
      if (args.courseId) {
        const [label, columns, grades] = await Promise.all([
          client.courseName(args.courseId),
          client.listGradeColumns(args.courseId),
          client.listGrades(args.courseId, userId),
        ]);
        const byId = new Map(columns.map((c) => [c.id, c]));

        let rows = grades.map((g) => {
          const col = g.column ?? (g.columnId ? byId.get(g.columnId) : undefined);
          return {
            item: clip(columnName(col) || g.columnId, 50),
            grade: gradeText(g, col?.possible),
            status: g.status ?? g.submissionStatus?.status,
            due: col?.dueDate ? `${when(col.dueDate)} (${relativeDue(col.dueDate)})` : undefined,
            columnId: g.columnId,
            viewed: g.hasBeenViewedByStudent === false ? 'new' : undefined,
          };
        });
        if (args.gradedOnly) rows = rows.filter((r) => r.grade !== '-' && r.grade !== 'awaiting grade');

        // Columns with no grade row at all still matter. They are upcoming work.
        const seen = new Set(grades.map((g) => g.columnId));
        const ungraded = columns
          .filter((c) => !seen.has(c.id) && c.scorable !== false && !c.calculatedFormula)
          .map((c) => ({
            item: clip(columnName(c), 50),
            grade: '-',
            status: 'no submission',
            due: c.dueDate ? `${when(c.dueDate)} (${relativeDue(c.dueDate)})` : undefined,
            columnId: c.id,
            viewed: undefined,
          }));

        const final = await client.getFinalGradeColumn(args.courseId).catch(() => null);
        const finalNote = final
          ? `\n**Final grade column:** ${columnName(final)}${
              final.possible ? ` (out of ${final.possible})` : ''
            }${final.calculatedFormula ? '. Calculated/weighted' : ''}\n`
          : '';

        return text(
          [
            `# Grades: ${label}`,
            finalNote,
            table(args.gradedOnly ? rows : [...rows, ...ungraded]),
            '',
            '_Use `bb_get_grade_detail` with a columnId for feedback, attempts and submissions._',
          ].join('\n'),
        );
      }

      // ── all courses, via the batch fan-out ──
      const memberships = (await client.listCourses({ availableOnly: true })).slice(
        0,
        args.maxCourses ?? 15,
      );
      const labels = new Map<string, string>();
      for (const m of memberships) labels.set(m.course?.id ?? m.courseId, courseLabel(m.course));

      const requests = memberships.map((m) => ({
        method: 'GET' as const,
        relativeUrl: `v1/courses/${m.course?.id ?? m.courseId}/gradebook/grades?userId=${userId}&limit=100&expand=column,submissionStatus`,
      }));
      const responses = await client.batch<Paged<BbGrade>>(requests);

      const rows: Array<Record<string, string | number | undefined>> = [];
      const failures: string[] = [];

      responses.forEach((res, i) => {
        const courseId = memberships[i]?.course?.id ?? memberships[i]?.courseId ?? '?';
        const label = labels.get(courseId) ?? courseId;
        const status = res.status ?? res.code ?? 200;
        if (status >= 400 || !res.body) {
          failures.push(`${label} (HTTP ${status})`);
          return;
        }
        for (const g of res.body.results ?? []) {
          const col = g.column;
          const grade = gradeText(g, col?.possible);
          if (args.gradedOnly && (grade === '-' || grade === 'awaiting grade')) continue;
          rows.push({
            course: clip(label, 28),
            item: clip(columnName(col) || g.columnId, 40),
            grade,
            status: g.status ?? g.submissionStatus?.status,
            due: col?.dueDate ? relativeDue(col.dueDate) : undefined,
            courseId,
            columnId: g.columnId,
          });
        }
      });

      return text(
        [
          `# Grades across ${memberships.length - failures.length} course(s)`,
          '',
          table(rows),
          failures.length ? `\n_Could not read: ${failures.join('; ')}_` : '',
        ].join('\n'),
      );
    }),
  );

  server.registerTool(
    'bb_get_grade_detail',
    {
      title: 'Get grade detail with feedback',
      description:
        'Everything about one gradebook item: the score, rubric/points, due date, every attempt with its timestamp and status, the student\'s submitted text, and the instructor\'s written feedback. This is where feedback lives. The grade list does not carry it.',
      inputSchema: {
        courseId: z.string().describe('Course id, e.g. "_12345_1".'),
        columnId: z.string().describe('Gradebook column id from bb_list_grades.'),
        includeAttempts: z.boolean().optional().describe('Fetch attempt detail. Default true.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_get_grade_detail', async ({ courseId, columnId, includeAttempts }) => {
      const client = await getClient();
      const [label, column, grades] = await Promise.all([
        client.courseName(courseId),
        client.getGradeColumn(courseId, columnId),
        client.getColumnGrades(courseId, columnId),
      ]);

      const grade = grades[0];

      // The schema turns the raw score into the grade the student actually sees.
      let schema: BbGradeSchema | undefined;
      if (column.gradingSchemaId) {
        schema = await client
          .getGradeSchema(courseId, column.gradingSchemaId)
          .catch(() => undefined);
      }
      const letter = letterGrade(
        schema,
        grade?.effectiveScore ?? grade?.manualScore ?? grade?.displayGrade?.score,
        column.possible,
      );
      const head = table([
        { field: 'item', value: columnName(column) },
        { field: 'course', value: label },
        { field: 'grade', value: grade ? gradeText(grade, column.possible) : 'no grade record' },
        { field: 'letter grade', value: letter },
        { field: 'points possible', value: column.possible },
        { field: 'grading schema', value: schema?.title },
        { field: 'status', value: grade?.status },
        { field: 'due', value: column.dueDate ? `${when(column.dueDate)} (${relativeDue(column.dueDate)})` : undefined },
        { field: 'attempts allowed', value: column.multipleAttempts },
        { field: 'grading type', value: column.calculationType },
        { field: 'rubric attached', value: column.hasRubricAssociations ? 'yes' : undefined },
        { field: 'anonymous', value: column.anonymousGrading ? 'yes' : undefined },
        { field: 'released', value: column.gradesReleased === false ? 'not yet' : 'yes' },
        { field: 'override', value: grade?.displayGrade?.isOverride ? 'yes' : undefined },
        { field: 'last override', value: when(grade?.lastOverrideDate) },
        { field: 'contentId', value: column.contentId },
      ]);

      const description = column.description?.displayText
        ? htmlToText(column.description.displayText)
        : column.description?.rawText ?? '';

      // Attempt ids come off the grade record; the attempt endpoint carries the
      // submission text and the instructor's feedback.
      let attemptsBody = '';
      if (includeAttempts !== false) {
        const ids = [
          ...new Set(
            [grade?.lastAttemptId, grade?.firstAttemptId, grade?.highestAttemptId, grade?.lowestAttemptId].filter(
              (v): v is string => typeof v === 'string' && v.length > 0,
            ),
          ),
        ];

        const blocks: string[] = [];
        for (const id of ids.slice(0, 5)) {
          try {
            const a = await client.getAttempt(courseId, id);
            const submitted = a.studentSubmission?.displayText
              ? htmlToText(a.studentSubmission.displayText)
              : a.studentSubmission?.rawText ?? '';
            const feedback = a.feedbackToUser?.displayText
              ? htmlToText(a.feedbackToUser.displayText)
              : a.feedbackToUser?.rawText ?? '';
            const files = a.studentSubmissionFiles ?? [];

            blocks.push(
              [
                `### Attempt ${id}`,
                '',
                table([
                  { field: 'submitted', value: when(a.attemptDate) },
                  { field: 'status', value: a.status },
                  { field: 'grade', value: a.displayGrade?.score },
                  { field: 'graded', value: when(a.attemptLastGradedDate) },
                  { field: 'exempt', value: a.exempt ? 'yes' : undefined },
                  {
                    field: 'files',
                    value: files.length
                      ? files
                          .map((f) => `${f.fileName ?? f.id} (${fmtBytes(f.fileSize ?? 0)})`)
                          .join(', ')
                      : undefined,
                  },
                  { field: 'receipt', value: a.attemptReceipt?.confirmationNumber },
                ]),
                submitted ? `\n**Submitted text:**\n\n${clip(submitted, 2000)}` : '',
                feedback ? `\n**Instructor feedback:**\n\n${clip(feedback, 2000)}` : '',
                files.length ? `\n_Use \`bb_download_submission\` with attemptId=${id} to fetch the files._` : '',
              ].join('\n'),
            );
          } catch (err) {
            blocks.push(`### Attempt ${id}\n\n_Could not read: ${(err as Error).message}_`);
          }
        }

        if (blocks.length === 0) {
          // No attempt ids on the grade record: fall back to listing the column's
          // attempts directly, which works for instructor-role sessions.
          try {
            const list = await client.listColumnAttempts(courseId, columnId, { limit: 10 });
            attemptsBody = list.length
              ? table(
                  list.map((a) => ({
                    attemptId: a.id,
                    submitted: when(a.attemptDate),
                    status: a.status,
                    score: a.displayGrade?.score,
                  })),
                )
              : '_No attempts recorded._';
          } catch {
            attemptsBody = '_No attempts recorded._';
          }
        } else {
          attemptsBody = blocks.join('\n\n');
        }
      }

      return text(
        [
          `# ${columnName(column)}`,
          '',
          head,
          section('Instructions', clip(description, 3000)),
          section('Attempts', attemptsBody),
        ].join('\n'),
      );
    }),
  );

  server.registerTool(
    'bb_grade_summary',
    {
      title: 'Summarise grade standing per course',
      description:
        'Computes, per course, how many items are graded, the running points total, and the average percentage. Use this for "how am I doing overall?" questions rather than listing every item.',
      inputSchema: {
        maxCourses: z.number().int().min(1).max(40).optional().describe('Default 15.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_grade_summary', async ({ maxCourses }) => {
      const client = await getClient();
      const userId = await client.selfId();
      const memberships = (await client.listCourses({ availableOnly: true })).slice(
        0,
        maxCourses ?? 15,
      );

      const responses = await client.batch<Paged<BbGrade>>(
        memberships.map((m) => ({
          method: 'GET' as const,
          relativeUrl: `v1/courses/${m.course?.id ?? m.courseId}/gradebook/grades?userId=${userId}&limit=100&expand=column`,
        })),
      );

      const rows = responses.map((res, i) => {
        const m = memberships[i]!;
        const label = courseLabel(m.course);
        const status = res.status ?? res.code ?? 200;
        if (status >= 400 || !res.body) {
          return { course: clip(label, 34), graded: '-', total: '-', average: `HTTP ${status}` };
        }
        const items = res.body.results ?? [];
        let earned = 0;
        let possible = 0;
        let graded = 0;
        for (const g of items) {
          if (g.isExempt || g.isCalculatedColumnGrade) continue;
          const score = g.effectiveScore ?? g.manualScore ?? g.displayGrade?.score;
          const max = g.column?.possible ?? g.pointsPossible;
          if (score === undefined || !max) continue;
          earned += score;
          possible += max;
          graded += 1;
        }
        return {
          course: clip(label, 34),
          graded: `${graded}/${items.length}`,
          total: possible ? `${earned.toFixed(1)}/${possible.toFixed(1)}` : '-',
          average: possible ? `${Math.round((earned / possible) * 100)}%` : '-',
        };
      });

      return text(
        [
          '# Grade standing',
          '',
          table(rows),
          '',
          '_Averages are unweighted point totals over graded items only. A course\'s official weighted grade may differ. Check its final grade column._',
        ].join('\n'),
      );
    }),
  );
}
