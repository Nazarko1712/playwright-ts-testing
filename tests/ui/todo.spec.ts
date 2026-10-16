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

/**
 * Assertions live in the test, never behind a page-object helper.
 *
 * An earlier version of this file called `todo.expectTitles([...])`, which put
 * `expect` inside the page object. Two things went wrong: ESLint's
 * `playwright/expect-expect` reported "test has no assertions" because it could
 * not see through the helper, and a reader could not tell what a test verified
 * without opening another file.
 */
test.describe('TodoMVC', () => {
    let todo: TodoPage;

    test.beforeEach(async ({ page }) => {
        todo = new TodoPage(page);
        await todo.goto();
    });

    test('adds items and keeps their order', async () => {
        await todo.add('write playwright tests', 'learn typescript');

        await expect(todo.todoTitles).toHaveText(['write playwright tests', 'learn typescript']);
        await expect(todo.counter).toHaveText('2 items left');
    });

    test('completing an item moves it out of the Active filter', async () => {
        await todo.add('buy milk', 'call the bank');

        await todo.toggle('buy milk');
        await expect(todo.itemByTitle('buy milk')).toHaveClass(/completed/);

        await todo.filterBy('Active');
        await expect(todo.todoTitles).toHaveText(['call the bank']);

        await todo.filterBy('Completed');
        await expect(todo.todoTitles).toHaveText(['buy milk']);
    });

    test('clear completed removes only completed items', async () => {
        await todo.add('one', 'two', 'three');
        await todo.toggle('two');

        await todo.clearCompleted.click();

        await expect(todo.todoTitles).toHaveText(['one', 'three']);
        await expect(todo.counter).toHaveText('2 items left');
    });

    test('deleting an item removes it from the list', async () => {
        await todo.add('temporary', 'permanent');

        await todo.remove('temporary');

        await expect(todo.todoTitles).toHaveText(['permanent']);
    });

    test('state survives a reload', async ({ page }) => {
        await todo.add('persisted item');
        await page.reload();

        await expect(todo.todoTitles).toHaveText(['persisted item']);
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
