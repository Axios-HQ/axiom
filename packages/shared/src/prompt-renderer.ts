/**
 * Prompt template renderer using Liquid-compatible template engine
 * Compliant with Symphony spec Section 12
 */

import type { Issue, PromptRenderResult, WorkflowError } from "./types/symphony";

/**
 * Simple Liquid-compatible template engine
 * Supports: {{ variable }}, {{ variable.property }}, {% if %}, {% for %}
 */
class TemplateEngine {
  private template: string;
  private context: Record<string, unknown>;

  constructor(template: string, context: Record<string, unknown>) {
    this.template = template;
    this.context = context;
  }

  /**
   * Render the template with the given context
   */
  render(): string {
    let result = this.template;

    // Process if/endif blocks first
    result = this.processIfBlocks(result);

    // Process for loops
    result = this.processForLoops(result);

    // Process variable substitutions
    result = this.processVariables(result);

    return result;
  }

  /**
   * Process if/endif blocks
   */
  private processIfBlocks(content: string): string {
    // Handle {% if condition %} ... {% endif %}
    const ifPattern = /\{%\s*if\s+(\w+)\s*%\}([\s\S]*?)\{%\s*endif\s*%\}/g;

    return content.replace(ifPattern, (match, condition, body) => {
      const value = this.getVariable(condition);

      // Check if the value is truthy
      if (this.isTruthy(value)) {
        return body;
      }
      return "";
    });
  }

  /**
   * Process for loops
   */
  private processForLoops(content: string): string {
    // Handle {% for item in array %} ... {% endfor %}
    const forPattern =
      /\{%\s*for\s+(\w+)\s+in\s+(\w+(?:\.\w+)*)\s*%\}([\s\S]*?)\{%\s*endfor\s*%\}/g;

    return content.replace(forPattern, (match, itemVar, arrayPath, body) => {
      const array = this.getVariable(arrayPath);

      if (!Array.isArray(array)) {
        throw new Error(`Cannot iterate over non-array variable: ${arrayPath}`);
      }

      let result = "";
      for (const item of array) {
        // Create a new context with the loop variable
        const savedValue = this.context[itemVar];
        this.context[itemVar] = item;

        // Render the loop body
        const engine = new TemplateEngine(body, this.context);
        result += engine.render();

        // Restore the original value
        if (savedValue !== undefined) {
          this.context[itemVar] = savedValue;
        } else {
          delete this.context[itemVar];
        }
      }

      return result;
    });
  }

  /**
   * Process variable substitutions {{ variable }}
   */
  private processVariables(content: string): string {
    // Handle {{ variable }}, {{ variable.property }}, {{ variable | filter }}
    const varPattern = /\{\{([^}]+)\}\}/g;

    return content.replace(varPattern, (match, varExpr) => {
      const trimmed = varExpr.trim();

      // Handle filters ({{ variable | filter }})
      const filterMatch = trimmed.match(/^(.+?)\s*\|\s*(.+)$/);
      if (filterMatch) {
        const varPath = filterMatch[1].trim();
        const filterName = filterMatch[2].trim();

        const value = this.getVariable(varPath);
        return this.applyFilter(value, filterName);
      }

      // Simple variable substitution
      const value = this.getVariable(trimmed);
      return this.stringifyValue(value);
    });
  }

  /**
   * Get a variable value from context (supports dot notation)
   */
  private getVariable(path: string): unknown {
    const parts = path.split(".");
    let value: unknown = this.context;

    for (const part of parts) {
      if (value === null || value === undefined) {
        throw new Error(`Cannot access property '${part}' on null or undefined`);
      }

      if (typeof value === "object") {
        value = (value as Record<string, unknown>)[part];
      } else {
        throw new Error(`Cannot access property '${part}' on non-object value`);
      }
    }

    return value;
  }

  /**
   * Apply a filter to a value
   */
  private applyFilter(value: unknown, filterName: string): string {
    switch (filterName.toLowerCase()) {
      case "uppercase":
      case "upcase":
        return String(value).toUpperCase();
      case "lowercase":
      case "downcase":
        return String(value).toLowerCase();
      case "capitalize":
        return String(value).charAt(0).toUpperCase() + String(value).slice(1).toLowerCase();
      case "size":
      case "length":
        if (Array.isArray(value)) {
          return String(value.length);
        }
        return String(String(value).length);
      case "json":
        return JSON.stringify(value);
      default:
        throw new Error(`Unknown filter: ${filterName}`);
    }
  }

  /**
   * Convert a value to a string
   */
  private stringifyValue(value: unknown): string {
    if (value === null || value === undefined) {
      return "";
    }

    if (typeof value === "string") {
      return value;
    }

    if (typeof value === "number") {
      return String(value);
    }

    if (typeof value === "boolean") {
      return value ? "true" : "false";
    }

    if (Array.isArray(value)) {
      return value.map((v) => this.stringifyValue(v)).join(", ");
    }

    if (typeof value === "object") {
      return JSON.stringify(value);
    }

    return String(value);
  }

  /**
   * Check if a value is truthy
   */
  private isTruthy(value: unknown): boolean {
    if (value === null || value === undefined) {
      return false;
    }
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      return value !== 0;
    }
    if (typeof value === "string") {
      return value.length > 0;
    }
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    return true;
  }
}

/**
 * Render a prompt template with issue context
 * Spec: Section 12 - Prompt Construction and Context Assembly
 */
export function renderPromptTemplate(
  template: string,
  issue: Issue,
  attempt: number | null
): PromptRenderResult {
  try {
    // Validate template is not empty
    if (!template.trim()) {
      return {
        ok: true,
        prompt: "You are working on an issue from Linear.",
      };
    }

    // Build context
    const context: Record<string, unknown> = {
      issue,
      attempt,
    };

    // Render template
    const engine = new TemplateEngine(template, context);
    const prompt = engine.render();

    return {
      ok: true,
      prompt,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Determine error type
    let errorType: WorkflowError["type"] = "template_render_error";
    if (message.includes("Unknown filter")) {
      errorType = "template_render_error";
    } else if (message.includes("Cannot access")) {
      errorType = "template_render_error";
    }

    return {
      ok: false,
      error: {
        type: errorType,
        message,
      },
    };
  }
}

/**
 * Validate that a template can be parsed (compile-time check)
 * Spec: Section 5.4 - Prompt Template Contract
 */
export function validateTemplate(template: string): { ok: true } | { ok: false; error: string } {
  try {
    // Try to detect obvious syntax errors
    const unbalancedIfs = (template.match(/\{%\s*if\s/g) || []).length;
    const balancedEndifs = (template.match(/\{%\s*endif\s*%\}/g) || []).length;

    if (unbalancedIfs !== balancedEndifs) {
      return {
        ok: false,
        error: "Unbalanced if/endif blocks in template",
      };
    }

    const unbalancedFors = (template.match(/\{%\s*for\s/g) || []).length;
    const balancedEndFors = (template.match(/\{%\s*endfor\s*%\}/g) || []).length;

    if (unbalancedFors !== balancedEndFors) {
      return {
        ok: false,
        error: "Unbalanced for/endfor blocks in template",
      };
    }

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `Template validation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
