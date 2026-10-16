import { expect, test } from '@playwright/test';
import { TodoPage } from '../../src/pages/TodoPage';

/**
 * UI layer. Every test starts from a clean app state because TodoMVC persists
 * to localStorage - the isolation comes from Playwright giving each test a fresh
 * BrowserContext (its own cookies, storage and cache) out of the box.
 *
 * That context-per-test model is the answer to "how do you isolate UI tests":
 * contexts are cheap (they reuse one browser process), so parallel tests do not
 * share session state the way separate Selenium sessions would need to.
 */

test.describe('TodoMVC', () => {
    let todo: TodoPage;

    test.beforeEach(async ({ page }) => {
        todo = new TodoPage(page);
        await todo.goto();
    });

    test('adds items and keeps their order', async () => {
        await todo.add('write playwright tests', 'learn typescript');

        await todo.expectTitles(['write playwright tests', 'learn typescript']);
        await expect(todo.counter).toHaveText('2 items left');
    });

    test('completing an item moves it out of the Active filter', async () => {
        await todo.add('buy milk', 'call the bank');

        await todo.toggle('buy milk');
        await expect(todo.itemByTitle('buy milk')).toHaveClass(/completed/);

        await todo.filterBy('Active');
        await todo.expectTitles(['call the bank']);

        await todo.filterBy('Completed');
        await todo.expectTitles(['buy milk']);
    });

    test('clear completed removes only completed items', async () => {
        await todo.add('one', 'two', 'three');
        await todo.toggle('two');

        await todo.clearCompleted.click();

        await todo.expectTitles(['one', 'three']);
        await expect(todo.counter).toHaveText('2 items left');
    });

    test('deleting an item removes it from the list', async () => {
        await todo.add('temporary', 'permanent');

        await todo.remove('temporary');

        await todo.expectTitles(['permanent']);
    });

    test('state survives a reload', async ({ page }) => {
        await todo.add('persisted item');
        await page.reload();

        await todo.expectTitles(['persisted item']);
    });

    test('an empty title is rejected', async () => {
        await todo.newTodoInput.fill('   ');
        await todo.newTodoInput.press('Enter');

        // Negative assertion: prove the list stayed empty rather than that
        // "something" happened. toHaveCount(0) retries, unlike a bare count().
        await expect(todo.todoItems).toHaveCount(0);
    });

    test('strict mode catches an ambiguous locator', async ({ page }) => {
        await todo.add('duplicate', 'duplicate');

        // Two nodes match, so an action must fail loudly instead of guessing.
        // This is the behaviour that stops silent wrong-element clicks.
        await expect(page.getByTestId('todo-title')).toHaveCount(2);
        await expect(async () => {
            await page.getByTestId('todo-title').click({ timeout: 1_000 });
        }).rejects.toThrow(/strict mode violation/i);
    });
});
