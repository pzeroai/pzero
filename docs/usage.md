# Usage Guide

## Asking Questions

Type natural language questions in the chat panel on the left. The LLM generates a SQL query, executes it against DuckDB, and displays the results as an interactive chart on the dashboard.

Press **Enter** to send, **Shift+Enter** for a new line.

## Example Queries

### Volume and Activity

- "Compare Kalshi vs Polymarket daily volume over time"
- "Show Kalshi monthly trade count for the last year"
- "What are the top 10 highest-volume Polymarket markets?"

### Market Analysis

- "What are the top Kalshi categories by trading volume?"
- "How many open vs closed markets does each platform have?"
- "Show the distribution of Kalshi market prices"

### Calibration

- "How calibrated are Kalshi and Polymarket? Plot win rate vs price"
- "Show Kalshi calibration — do 70-cent contracts win 70% of the time?"

### Cross-Platform

- "Compare the number of markets on Kalshi vs Polymarket"
- "Which platform has higher daily volume in 2024?"

## Dashboard

### Widget Grid

Charts appear on the right side in a draggable, resizable grid.

- **Drag** from the title bar to reposition
- **Resize** from edges/corners
- **Close** with the X button in the header

### Refine

Click the **Refine** button on any widget to open an inline editor. Type instructions to modify the chart:

- "Make it a line chart"
- "Filter to Sports only"
- "Show only 2024 data"
- "Change the title to ..."

Refinements maintain full conversation history, so the LLM understands context from previous edits.

### Natural Language Targeting

Reference existing widgets in the main chat by name or position:

- "In the volume chart, filter to 2024 only"
- "Make the 2nd chart a line chart"
- "Update the first one to show percentages"

The LLM updates the existing widget instead of creating a new one.

### Info Tooltip

Hover the info icon next to the chart title to see the LLM's explanation of what the chart shows.

## Supported Chart Types

| Type      | Best For                            |
|-----------|-------------------------------------|
| bar       | Comparing categories                |
| line      | Time series, trends                 |
| scatter   | Correlations between two variables  |
| area      | Volume over time                    |
| pie       | Proportions of a whole              |
| histogram | Distribution of values              |

The LLM automatically selects the most appropriate chart type based on your question.

## Smart Formatting

- **Date axes**: Auto-detects granularity
  - Quarterly format (2024Q1) for spans > 1 year
  - Monthly format (Jan 2024) for spans > 60 days
  - Daily format (Jan 15) for shorter spans
- **Number axes**: K/M/B abbreviations (1,200,000 -> 1.2M)
- **Multi-series**: Grouped bars or multi-line charts when comparing categories
