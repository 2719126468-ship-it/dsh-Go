// 社区: the community hub. Curated content from community.json: picked plugins
// (installed through the plugin market), prompt ideas that open a new
// conversation, group links with QR codes, and news. Nothing users write is
// hosted here.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../l10n/l10n.dart';
import '../../state/app_info.dart';
import '../../state/community_state.dart';
import '../../state/plugins_state.dart';
import '../../state/safe_mode_state.dart' show repairDraftProvider;
import '../common/empty_view.dart';
import '../common/feature_tile.dart';
import '../common/list_page_row.dart';
import '../common/overview_card.dart';
import '../common/tile_grid.dart';
import '../settings/settings_widgets.dart' show SettingsSection;
import '../share/share_content.dart' show dshGoProjectUrl;
import '../shell/brand_mark.dart';
import '../shell/page_frame.dart';
import '../theme/app_icons.dart';
import '../theme/theme.dart';
import 'community_widgets.dart';

class CommunityPage extends ConsumerWidget {
  const CommunityPage({super.key, this.onOpenForum});

  /// 「论坛」 at the top of the hub, opening the forum's home; null shows the
  /// project card there instead.
  final VoidCallback? onOpenForum;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final community = ref.watch(communityProvider);
    final feed = community.value?.feed;
    final children = <Widget>[_Overview(onOpenForum: onOpenForum, tagline: feed?.tagline)];
    if (feed == null) {
      // The bundled copy loads in a frame or two; nothing to spin for.
    } else if (feed.isEmpty) {
      children.add(
        EmptyView(
          art: FeatureTile(FeatureKind.community, size: FeatureTile.empty),
          title: l10n.botsCommunityEmpty,
        ),
      );
    } else {
      if (feed.plugins.isNotEmpty) children.add(_Plugins(picks: feed.plugins));
      if (feed.projects.isNotEmpty) children.add(_Projects(projects: feed.projects));
      if (feed.prompts.isNotEmpty) children.add(_Prompts(prompts: feed.prompts));
      if (feed.groups.isNotEmpty) {
        children.add(
          SettingsSection(
            title: l10n.botsCommunityGroups,
            children: [for (final group in feed.groups) CommunityGroupRow(group: group)],
          ),
        );
      }
      if (feed.updates.isNotEmpty) children.add(_Updates(updates: feed.updates));
    }
    return AppPage.list(title: l10n.botsCommunity, children: children);
  }
}

/// The page's lead: the forum when there is one, else the project itself.
class _Overview extends StatelessWidget {
  const _Overview({required this.onOpenForum, required this.tagline});

  final VoidCallback? onOpenForum;
  final String? tagline;

  /// The glyph's height in the 52 avatar circle.
  static const _markSize = 26.0;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final forum = onOpenForum;
    if (forum != null) {
      return OverviewCard(
        leading: const OverviewGlyph(AppIcons.forum, tint: CommunityHues.forum),
        title: Text(l10n.botsForum),
        subtitle: Text(l10n.botsForumSubtitle),
        onTap: forum,
      );
    }
    final colors = DshColors.of(context);
    return OverviewCard(
      semanticLabel: l10n.botsProjectHome,
      leading: DecoratedBox(
        decoration: ShapeDecoration(color: colors.identity[0], shape: const CircleBorder()),
        // Centred on its visual centre, not its box.
        child: Center(
          child: Transform.translate(
            offset: BrandMark.opticalShift(_markSize),
            child: const BrandMark(size: _markSize),
          ),
        ),
      ),
      title: const Text(AppInfo.name),
      subtitle: Text(tagline ?? l10n.botsOpenSource),
      onTap: () => unawaited(openCommunityLink(context, dshGoProjectUrl)),
    );
  }
}

/// 精选插件: the picks found in the market index, each opening the market's
/// detail sheet.
class _Plugins extends ConsumerWidget {
  const _Plugins({required this.picks});

  final List<CommunityPlugin> picks;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final catalog = ref.watch(marketAllProvider);
    final bundles = ref.watch(installedPluginsProvider.select((state) => state.value));
    bool isPreinstalled(CommunityPlugin pick) =>
        bundles?.any((bundle) => bundle.name == pick.name && isDshGoPreinstalledBundle(bundle)) ?? false;
    final rows = catalog.when<List<Widget>>(
      skipLoadingOnRefresh: false,
      loading: () => [
        for (final pick in picks)
          if (isPreinstalled(pick)) CommunityPluginRow(pick: pick, entry: null),
      ],
      error: (_, _) => [
        ListPageRow(
          icon: AppIcons.refresh,
          title: l10n.botsPluginCatalogFailed,
          subtitle: l10n.botsTapRetry,
          onTap: () => ref.invalidate(marketCatalogProvider),
        ),
        for (final pick in picks)
          if (isPreinstalled(pick)) CommunityPluginRow(pick: pick, entry: null),
      ],
      data: (catalog) => [
        for (final pick in picks)
          if (catalog.byName[pick.name] != null || isPreinstalled(pick))
            CommunityPluginRow(pick: pick, entry: catalog.byName[pick.name]),
      ],
    );
    if (rows.isEmpty) return const SizedBox.shrink();
    return SettingsSection(title: l10n.botsFeaturedPlugins, footer: Text(l10n.botsPluginSource), children: rows);
  }
}

class _Projects extends StatelessWidget {
  const _Projects({required this.projects});

  final List<CommunityProject> projects;

  @override
  Widget build(BuildContext context) {
    final locale = Localizations.localeOf(context).languageCode;
    final chinese = locale == 'zh';
    String formatStars(int count) => count >= 1000 ? '${(count / 1000).toStringAsFixed(1)}k' : '$count';
    return SettingsSection(
      title: chinese ? 'GitHub 热门项目' : 'Popular GitHub projects',
      footer: Text(
        chinese
            ? '仅展示源码项目，不会自动安装或运行。星标为 2026-11-15 快照；安装前请核对项目说明与宿主兼容性。'
            : 'Source links only; nothing is installed or executed. Stars are a 2026-11-15 snapshot. Check project instructions and host compatibility before installing.',
      ),
      children: [
        for (final project in projects)
          ListPageRow(
            icon: AppIcons.code,
            title: project.repository,
            subtitle: '${project.note.resolve(locale)} · ${project.compatibility.resolve(locale)}',
            subtitleMaxLines: 3,
            meta: '${formatStars(project.stars)} ★ · ${project.license}',
            onTap: () => unawaited(openCommunityLink(context, project.url)),
          ),
      ],
    );
  }
}

/// 玩法: two columns of prompt tiles; a tap opens a new conversation with the
/// prompt in the composer (not sent).
class _Prompts extends ConsumerWidget {
  const _Prompts({required this.prompts});

  final List<CommunityPrompt> prompts;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    void start(CommunityPrompt prompt) {
      HapticFeedback.selectionClick();
      ref.read(repairDraftProvider.notifier).request(prompt.prompt);
      Navigator.of(context).popUntil((route) => route.isFirst);
    }

    return Padding(
      padding: const EdgeInsets.only(bottom: 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(
            // SettingsSection's title column: 16 page inset + 8.
            padding: const EdgeInsets.fromLTRB(24, 0, 24, 8),
            child: Semantics(
              header: true,
              child: Text(l10n.botsPromptIdeas, style: SettingsSection.titleStyle(context)),
            ),
          ),
          TileGrid(
            children: [
              for (final prompt in prompts)
                FeatureCard(
                  icon: communityPromptIcon(prompt.icon),
                  tint: CommunityHues.prompts,
                  title: prompt.title,
                  subtitle: prompt.summary,
                  onTap: () => start(prompt),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

/// 更新动态: newest first; a row with a link opens it.
class _Updates extends StatelessWidget {
  const _Updates({required this.updates});

  final List<CommunityUpdate> updates;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final sorted = [...updates]..sort((a, b) => b.date.compareTo(a.date));
    return SettingsSection(
      title: l10n.botsUpdates,
      children: [
        for (final update in sorted.take(8))
          ListPageRow(
            title: update.title,
            subtitle: update.summary,
            subtitleMaxLines: 2,
            meta: communityDate(update.date),
            chevron: false,
            onTap: update.url == null ? null : () => unawaited(openCommunityLink(context, update.url!)),
          ),
      ],
    );
  }
}
