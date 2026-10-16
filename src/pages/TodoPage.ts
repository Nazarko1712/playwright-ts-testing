import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Page object for the TodoMVC demo app.
 *
 * The single most important difference from WebdriverIO/Selenium:
 * a Playwright `Locator` is LAZY. `page.getByRole(...)` performs no lookup - it
 * stores a strategy. The DOM query happens at the moment of the action or the
 * assertion, and Playwright re-queries and re-checks actionability until the
 * timeout. Consequences worth stating in an interview:
 *
 *  - A locator cannot go stale, so there is no StaleElementReferenceException.
 *  - You can build locators in the constructor; nothing is resolved yet.
 *  - `waitForDisplayed` / `waitForClickable` are unnecessary: before a click
 *    Playwright waits for the element to be attached, visible, stable, to
 *    receive events (nothing overlaying it) and to be enabled.
 *  - A locator matching several nodes throws on action ("strict mode"), instead
 *    of silently acting on the first one. That catches ambiguous selectors.
 */
export class TodoPage {
    readonly page: Page;
    readonly newTodoInput: Locator;
    readonly todoItems: Locator;
    readonly todoTitles: Locator;
    readonly counter: Locator;
    readonly toggleAll: Locator;
    readonly clearCompleted: Locator;

    constructor(page: Page) {
        this.page = page;
        this.newTodoInput = page.getByPlaceholder('What needs to be done?');
        this.todoItems = page.getByTestId('todo-item');
        this.todoTitles = page.getByTestId('todo-title');
        this.counter = page.getByTestId('todo-count');
        this.toggleAll = page.getByLabel('Mark all as complete');
        this.clearCompleted = page.getByRole('button', { name: 'Clear completed' });
    }

    async goto(): Promise<void> {
        await this.page.goto('/todomvc');
    }

    async add(...titles: string[]): Promise<void> {
        for (const title of titles) {
            await this.newTodoInput.fill(title);
            await this.newTodoInput.press('Enter');
        }
    }

    /** Scoped locator: find the row by its text, then the control inside it. */
    itemByTitle(title: string): Locator {
        return this.todoItems.filter({ hasText: title });
    }

    async toggle(title: string): Promise<void> {
        await this.itemByTitle(title).getByRole('checkbox').check();
    }

    async remove(title: string): Promise<void> {
        const item = this.itemByTitle(title);
        // The delete button only exists on hover, so the hover is the precondition.
        await item.hover();
        await item.getByRole('button', { name: 'Delete' }).click();
    }

    async filterBy(name: 'All' | 'Active' | 'Completed'): Promise<void> {
        await this.page.getByRole('link', { name }).click();
    }

    /** Web-first assertion: retries until it matches or the expect timeout fires. */
    async expectTitles(titles: string[]): Promise<void> {
        await expect(this.todoTitles).toHaveText(titles);
    }
}
