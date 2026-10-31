import { useEffect, useRef } from "react";
import { init, use, type EChartsCoreOption } from "echarts/core";
import { LineChart, PieChart, BarChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  GraphicComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { HistoryPoint } from "../shared/types";

use([
  LineChart,
  PieChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  GraphicComponent,
  CanvasRenderer,
]);

function Chart({
  option,
  className = "",
  label,
}: {
  option: EChartsCoreOption;
  className?: string;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = init(ref.current, undefined, { renderer: "canvas" });
    chart.setOption(option);
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [option]);
  return (
    <div
      ref={ref}
      className={`chart ${className}`}
      role="img"
      aria-label={label}
    />
  );
}

export function NavChart({
  history,
  light,
  seriesLabel = "单位净值",
}: {
  history: HistoryPoint[];
  light: boolean;
  seriesLabel?: string;
}) {
  const text = light ? "#6b7776" : "#7e9192";
  const line = light ? "#e7eeea" : "#253034";
  const values = history.map((p) => Number(p.nav));
  const option: EChartsCoreOption = {
    animationDuration: 400,
    grid: { left: 12, right: 16, top: 22, bottom: 10, containLabel: true },
    tooltip: {
      renderMode: "richText",
      trigger: "axis",
      backgroundColor: light ? "#fff" : "#202a2f",
      borderColor: line,
      textStyle: { color: light ? "#182525" : "#e9f0ec", fontSize: 12 },
      axisPointer: {
        type: "line",
        lineStyle: { color: "#92cdb1", type: "dashed" },
      },
      valueFormatter: (v: unknown) => Number(v).toFixed(4),
    },
    xAxis: {
      type: "category",
      data: history.map((p) => p.date),
      boundaryGap: false,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: text,
        fontSize: 10,
        margin: 18,
        hideOverlap: true,
        formatter: (v: string) => v.slice(2),
      },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      scale: true,
      splitNumber: 4,
      axisLabel: { color: text, fontSize: 10, margin: 12 },
      splitLine: { lineStyle: { color: line, type: "dashed" } },
    },
    series: [
      {
        name: seriesLabel,
        type: "line",
        data: values,
        smooth: false,
        showSymbol: false,
        symbolSize: 5,
        lineStyle: { width: 2, color: "#83d4b3" },
        itemStyle: { color: "#83d4b3" },
        areaStyle: {
          color: {
            type: "linear",
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: "rgba(128,211,177,.19)" },
              { offset: 1, color: "rgba(128,211,177,0)" },
            ],
          },
        },
      },
    ],
  };
  return (
    <Chart
      option={option}
      label={`${seriesLabel}历史走势，共 ${history.length} 个数据点`}
    />
  );
}

export function AllocationChart({
  values,
  light,
}: {
  values: { name: string; value: number }[];
  light: boolean;
}) {
  return (
    <Chart
      label="资产配置比例"
      className="allocation-chart"
      option={{
        color: [
          "#a9e4c8",
          "#739bc8",
          "#bba4d9",
          "#c6b98d",
          "#6ebfc1",
          "#73867c",
        ],
        tooltip: {
          renderMode: "richText",
          trigger: "item",
          backgroundColor: light ? "#fff" : "#202a2f",
          borderWidth: 0,
          textStyle: { color: light ? "#182525" : "#e9f0ec" },
          formatter: "{b}<br/>{d}%",
        },
        series: [
          {
            type: "pie",
            radius: ["68%", "88%"],
            center: ["50%", "50%"],
            padAngle: 3,
            itemStyle: { borderRadius: 3 },
            label: { show: false },
            emphasis: { scaleSize: 4 },
            data: values,
          },
        ],
      }}
    />
  );
}
