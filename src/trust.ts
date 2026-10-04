import { copyFile, readFile } from 'node:fs/promises';
import { z } from 'zod';
import { writeFileAtomic } from './atomic-write.ts';

const claudeConfigSchema = z.looseObject({
	projects: z.record(z.string(), z.looseObject({ hasTrustDialogAccepted: z.boolean().optional() })).optional(),
});

const ATTEMPTS = 5;

// Pre-accepts Claude Code's folder trust dialog. Claude rewrites this file often, so the write only lands if the
// file is still what was read; otherwise it starts over from the fresh contents.
export async function trustFolder(configPath: string, folder: string) {
	for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
		const before = await readFile(configPath, 'utf8');
		const config = claudeConfigSchema.parse(JSON.parse(before));
		const project = config.projects?.[folder];

		if (project?.hasTrustDialogAccepted) {
			return;
		}

		const next = { ...config, projects: { ...config.projects, [folder]: { ...project, hasTrustDialogAccepted: true } } };

		await copyFile(configPath, `${configPath}.herdr-linear.bak`);

		if ((await readFile(configPath, 'utf8')) === before) {
			await writeFileAtomic(configPath, JSON.stringify(next, null, 2));

			return;
		}
	}

	throw new Error(`${configPath} kept changing; could not pre-accept the trust dialog for ${folder}`);
}
