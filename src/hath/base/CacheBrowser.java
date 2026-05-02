/*

Copyright 2008-2026 E-Hentai.org
https://forums.e-hentai.org/
tenboro@e-hentai.org

This file is part of Hentai@Home.

Hentai@Home is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

Hentai@Home is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with Hentai@Home.  If not, see <https://www.gnu.org/licenses/>.

*/

package hath.base;

import java.io.File;
import java.util.Hashtable;
import java.util.regex.Pattern;

public class CacheBrowser {
	public static boolean isAccessAllowed(boolean localNetworkAccess, String additional) {
		if(localNetworkAccess) {
			return true;
		}

		String expected = Settings.getTelemetryToken();
		if(expected == null || expected.isEmpty()) {
			return false;
		}

		Hashtable<String,String> add = Tools.parseAdditional(additional);
		String token = add.get("token");
		return expected.equals(token);
	}

	public static HVFile resolveCachedFile(String fileid) {
		HVFile hvFile = HVFile.getHVFileFromFileid(fileid);
		if(hvFile == null) {
			return null;
		}

		File requestedFile = hvFile.getLocalFileRef();
		if(!requestedFile.exists() || requestedFile.length() != hvFile.getSize()) {
			return null;
		}

		return hvFile;
	}

	public static String getCacheListJson(String additional) {
		Hashtable<String,String> add = Tools.parseAdditional(additional);
		String prefix = add.get("prefix");
		int limit = parseIntSafe(add.get("limit"), 200, 1, 500);
		int offset = parseIntSafe(add.get("offset"), 0, 0, Integer.MAX_VALUE);
		if(prefix == null) {
			prefix = "";
		}
		prefix = prefix.toLowerCase();
		if(!Pattern.matches("^[a-f0-9]{0,40}$", prefix)) {
			prefix = "";
		}

		StringBuilder sb = new StringBuilder(1024);
		sb.append("{");
		sb.append("\"prefix\":\"").append(prefix).append("\",");
		sb.append("\"offset\":").append(offset).append(",");
		sb.append("\"limit\":").append(limit).append(",");
		sb.append("\"items\":[");

		File cacheDir = Settings.getCacheDir();
		int emitted = 0;
		int total = 0;
		Integer nextOffset = null;

		if(prefix.length() == 0) {
			File[] l1dirs = Tools.listSortedFiles(cacheDir);
			if(l1dirs != null) {
				for(File dir : l1dirs) {
					if(!dir.isDirectory()) {
						continue;
					}
					if(emitted > 0) {
						sb.append(",");
					}
					sb.append("{\"type\":\"dir\",\"name\":\"").append(dir.getName()).append("\",\"prefix\":\"").append(dir.getName()).append("\"}");
					++emitted;
				}
			}
			sb.append("]}");
			return sb.toString();
		}

		if(prefix.length() == 2) {
			File l1 = new File(cacheDir, prefix);
			File[] l2dirs = Tools.listSortedFiles(l1);
			if(l2dirs != null) {
				for(File dir : l2dirs) {
					if(!dir.isDirectory()) {
						continue;
					}
					if(emitted > 0) {
						sb.append(",");
					}
					sb.append("{\"type\":\"dir\",\"name\":\"").append(dir.getName()).append("\",\"prefix\":\"").append(prefix).append(dir.getName()).append("\"}");
					++emitted;
				}
			}
			sb.append("]}");
			return sb.toString();
		}

		if(prefix.length() >= 4) {
			String l1 = prefix.substring(0, 2);
			String l2 = prefix.substring(2, 4);
			File targetDir = new File(new File(cacheDir, l1), l2);
			File[] files = Tools.listSortedFiles(targetDir);
			if(files != null) {
				for(File f : files) {
					if(!f.isFile()) {
						continue;
					}
					String name = f.getName();
					if(!name.startsWith(prefix)) {
						continue;
					}
					++total;
					if(total <= offset) {
						continue;
					}
					if(emitted >= limit) {
						nextOffset = offset + emitted;
						break;
					}

					HVFile hvFile = HVFile.getHVFileFromFileid(name);
					if(hvFile == null) {
						continue;
					}
					if(emitted > 0) {
						sb.append(",");
					}
					sb.append("{\"type\":\"file\",\"fileid\":\"").append(name).append("\",\"display_name\":\"").append(getDisplayName(hvFile));
					sb.append("\",\"extension\":\"").append(getDisplayExtension(hvFile.getType())).append("\",\"size\":").append(hvFile.getSize());
					sb.append(",\"mime\":\"").append(hvFile.getMimeType()).append("\",\"last_modified\":").append(f.lastModified() / 1000).append("}");
					++emitted;
				}
			}
		}

		sb.append("],\"next_offset\":");
		if(nextOffset == null) {
			sb.append("null");
		}
		else {
			sb.append(nextOffset.intValue());
		}
		sb.append("}");
		return sb.toString();
	}

	private static int parseIntSafe(String value, int def, int min, int max) {
		try {
			int v = Integer.parseInt(value);
			return Math.max(min, Math.min(max, v));
		}
		catch(Exception e) {
			return def;
		}
	}

	private static String getDisplayName(HVFile hvFile) {
		return hvFile.getHash() + "." + getDisplayExtension(hvFile.getType());
	}

	private static String getDisplayExtension(String type) {
		if(type.equals("wbp")) {
			return "webp";
		}

		if(type.equals("wbm")) {
			return "webm";
		}

		if(type.equals("avf")) {
			return "avif";
		}

		return type;
	}
}
