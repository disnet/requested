/**
 * Theme store. Three values: 'light' | 'dark' | 'system'.
 * Persisted to localStorage. When 'system', no data-theme attribute is set
 * and CSS @media (prefers-color-scheme) takes over.
 */

import { browser } from '$app/environment';

export type ThemePref = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'atrfc:theme';

function readInitial(): ThemePref {
	if (!browser) return 'system';
	const raw = localStorage.getItem(STORAGE_KEY);
	if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
	return 'system';
}

function apply(pref: ThemePref) {
	if (!browser) return;
	const root = document.documentElement;
	if (pref === 'system') {
		root.removeAttribute('data-theme');
	} else {
		root.setAttribute('data-theme', pref);
	}
}

class ThemeStore {
	pref = $state<ThemePref>(readInitial());

	init() {
		apply(this.pref);
	}

	set(next: ThemePref) {
		this.pref = next;
		apply(next);
		if (browser) {
			if (next === 'system') localStorage.removeItem(STORAGE_KEY);
			else localStorage.setItem(STORAGE_KEY, next);
		}
	}

	/** Cycle light → dark → system → light. */
	cycle() {
		const order: ThemePref[] = ['light', 'dark', 'system'];
		const idx = order.indexOf(this.pref);
		this.set(order[(idx + 1) % order.length]);
	}
}

export const theme = new ThemeStore();
