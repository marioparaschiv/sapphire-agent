import { open, rename } from 'node:fs/promises';

// Readers see either the old or the new file, never a partial write.
export async function writeFileAtomic(path: string, data: string, mode = 0o600) {
	const tempPath = `${path}.${process.pid}.tmp`;
	const file = await open(tempPath, 'w', mode);

	try {
		await file.writeFile(data);
		await file.sync();
	} finally {
		await file.close();
	}

	await rename(tempPath, path);
}
