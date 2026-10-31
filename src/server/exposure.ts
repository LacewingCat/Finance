import { Decimal } from "decimal.js";
import type { Exposure } from "../shared/types.js";

export interface ExposureIssue {
  path: string;
  code: string;
  message: string;
}
export interface ExposureCoverage {
  basis: Exposure["basis"];
  reportDate: string;
  scope: "allocation" | "holdings";
  reportedWeight: string;
  unreportedWeight: string | null;
}
export interface FlatExposure extends Exposure {
  path: string[];
  effectiveWeight?: string;
  unresolved?: string;
}

const isAllocation = (x: Exposure) => x.kind === "asset_class";
const number = (s: string): Decimal | null => {
  if (!/^-?\d+(?:\.\d+)?$/.test(s)) return null;
  try {
    const value = new Decimal(s);
    return value.isFinite() ? value : null;
  } catch {
    return null;
  }
};

/** Holdings and allocation tables have different denominators and are never added together. */
export function validateExposureGraph(exposures: Exposure[]): {
  valid: boolean;
  issues: ExposureIssue[];
  coverage: ExposureCoverage[];
} {
  const issues: ExposureIssue[] = [];
  const inspect = (
    nodes: Exposure[],
    path: string[],
    ancestors: Set<Exposure>,
  ): void => {
    if (path.length > 12) {
      issues.push({
        path: path.join(" > "),
        code: "depth",
        message: "穿透深度超过 12 层，剩余暴露未解析。",
      });
      return;
    }
    const duplicates = new Set<string>();
    for (const node of nodes) {
      const where = [...path, node.name].join(" > ");
      if (ancestors.has(node)) {
        issues.push({
          path: where,
          code: "cycle",
          message: "穿透图存在循环。",
        });
        continue;
      }
      const weight = number(node.weight);
      if (!weight)
        issues.push({
          path: where,
          code: "weight",
          message: "权重必须是有限十进制百分比。",
        });
      if (weight?.isNegative())
        issues.push({
          path: where,
          code: "signed_exposure",
          message: "负权重可能代表对冲或负债，不能解释为普通多头持仓。",
        });
      const validDate =
        /^\d{4}-\d{2}-\d{2}$/.test(node.reportDate) &&
        Number.isFinite(Date.parse(node.reportDate)) &&
        new Date(node.reportDate).toISOString().slice(0, 10) ===
          node.reportDate;
      if (!validDate)
        issues.push({
          path: where,
          code: "report_date",
          message: "缺少可核实的报告期。",
        });
      if (!node.sourceUrl.startsWith("https://"))
        issues.push({
          path: where,
          code: "source",
          message: "缺少 HTTPS 披露来源。",
        });
      const key = `${node.basis}|${node.reportDate}|${node.kind}|${node.code ?? node.name}`;
      if (duplicates.has(key))
        issues.push({
          path: where,
          code: "duplicate",
          message: "同一披露组内有重复标的。",
        });
      duplicates.add(key);
      if (node.children?.length) {
        if (node.children.some((child) => child.basis !== node.basis))
          issues.push({
            path: where,
            code: "mixed_basis",
            message: "父子层分母不同，缺少净资产/总资产换算，不能直接相乘。",
          });
        if (node.children.some((child) => child.reportDate !== node.reportDate))
          issues.push({
            path: where,
            code: "mixed_dates",
            message: "穿透层使用不同报告期，结果属于跨期近似。",
          });
        inspect(
          node.children,
          [...path, node.name],
          new Set([...ancestors, node]),
        );
      }
    }
  };
  inspect(exposures, [], new Set());
  const groups = new Map<string, ExposureCoverage>();
  for (const node of exposures) {
    const value = number(node.weight);
    if (!value) continue;
    const scope = isAllocation(node) ? "allocation" : "holdings";
    const key = `${node.basis}|${node.reportDate}|${scope}`;
    const prior = groups.get(key);
    const sum = new Decimal(prior?.reportedWeight ?? 0).plus(value);
    groups.set(key, {
      basis: node.basis,
      reportDate: node.reportDate,
      scope,
      reportedWeight: sum.toFixed(),
      unreportedWeight:
        sum.greaterThan(100) || sum.isNegative()
          ? null
          : new Decimal(100).minus(sum).toFixed(),
    });
  }
  for (const group of groups.values()) {
    if (new Decimal(group.reportedWeight).greaterThan(100.1))
      issues.push({
        path: group.scope,
        code: "over_100",
        message: `${group.basis} 披露权重超过 100%，须核对杠杆、负债或重复数据。`,
      });
  }
  const blocking = new Set([
    "weight",
    "cycle",
    "depth",
    "duplicate",
    "report_date",
    "source",
  ]);
  return {
    valid: !issues.some((issue) => blocking.has(issue.code)),
    issues,
    coverage: [...groups.values()],
  };
}

/** Unknown portions remain explicit; no normalization to 100%, ticker guessing or denominator conversion. */
export function flattenExposures(exposures: Exposure[]): FlatExposure[] {
  const result: FlatExposure[] = [];
  const walk = (
    nodes: Exposure[],
    path: string[],
    factor: Decimal,
    basis?: Exposure["basis"],
    ancestors = new Set<Exposure>(),
  ): void => {
    for (const node of nodes) {
      const nextPath = [...path, node.name];
      const weight = number(node.weight);
      const unresolved = ancestors.has(node)
        ? "循环引用"
        : path.length > 12
          ? "超过最大深度"
          : !weight
            ? "无效权重"
            : basis && basis !== node.basis
              ? "分母不同，无法换算"
              : undefined;
      if (unresolved) {
        result.push({
          ...node,
          children: undefined,
          path: nextPath,
          unresolved,
        });
        continue;
      }
      const effective = factor.mul(weight!).div(100);
      if (node.children?.length) {
        walk(
          node.children.filter((child) => !isAllocation(child)),
          nextPath,
          effective,
          node.basis,
          new Set([...ancestors, node]),
        );
        const relevant = node.children.filter(
          (x) => x.basis === node.basis && !isAllocation(x),
        );
        const sum = relevant.reduce(
          (total, child) => total.plus(number(child.weight) ?? 0),
          new Decimal(0),
        );
        if (
          sum.lessThan(100) &&
          !node.children.some((child) => child.basis !== node.basis)
        ) {
          result.push({
            name: `${node.name}：未披露部分`,
            kind: "unreported",
            weight: new Decimal(100).minus(sum).toFixed(),
            effectiveWeight: effective
              .mul(new Decimal(100).minus(sum))
              .div(100)
              .toFixed(),
            basis: node.basis,
            reportDate: node.reportDate,
            sourceUrl: node.sourceUrl,
            path: nextPath,
            unresolved: "下层披露覆盖不足，未推测其资产构成",
          });
        }
      } else
        result.push({
          ...node,
          path: nextPath,
          effectiveWeight: effective.toFixed(),
        });
    }
  };
  // Asset-allocation totals are a separate view, not extra holdings.
  walk(
    exposures.filter((x) => !isAllocation(x)),
    [],
    new Decimal(100),
  );
  return result;
}

export const flattenExposureGraph = flattenExposures;
