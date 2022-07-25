// Vertical Workspaces
// GPL v3 ©G-dH@Github.com
// used parts of https://github.com/RensAlthuis/vertical-overview extension

'use strict';

const { Clutter, Gio, GLib, GObject, Graphene, Meta, Shell, St } = imports.gi;

const DND = imports.ui.dnd;
const Main = imports.ui.main;
const AppDisplay = imports.ui.appDisplay;
const Dash = imports.ui.dash;
const Layout = imports.ui.layout;
const Overview = imports.ui.overview;
const Util = imports.misc.util;
const WorkspaceThumbnail = imports.ui.workspaceThumbnail;
const Background = imports.ui.background;
const WorkspacesView = imports.ui.workspacesView;
const Workspace = imports.ui.workspace;
const OverviewControls = imports.ui.overviewControls;
const WindowPreview = imports.ui.windowPreview;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Settings = Me.imports.settings;
const shellVersion = Settings.shellVersion;

const VerticalDash = Me.imports.dash;

const _Util = Me.imports.util;


// touching modul properties defined by const/let for the first time returns undefined in GS 42, so we touch it here before we use it
WorkspacesView.SecondaryMonitorDisplay;
WorkspacesView.SECONDARY_WORKSPACE_SCALE;
WindowPreview.ICON_SIZE;

let gOptions = null;
let original_MAX_THUMBNAIL_SCALE;

const BACKGROUND_CORNER_RADIUS_PIXELS = 40;

const WORKSPACE_CUT_SIZE = 10;

// keep adjacent workspaces out of the screen
let WORKSPACE_MAX_SPACING = 350;
let WORKSPACE_MIN_SPACING = Main.overview._overview._controls._thumbnailsBox.get_theme_node().get_length('spacing');

let DASH_MAX_SIZE_RATIO = 0.15;

const ControlsState = {
    HIDDEN: 0,
    WINDOW_PICKER: 1,
    APP_GRID: 2,
};

const DashPosition = {
    TOP: 0,
    RIGHT: 1,
    BOTTOM: 2,
    LEFT: 3
}

let verticalOverrides = {};
let _windowPreviewInjections = {};
let _appDisplayScrollConId;

let _monitorsChangedSigId;
let _shellSettings;
let _watchDockSigId;
let _resetTimeoutId;
let _resetExtensionIfEnabled;
let _shownOverviewSigId;
let _showingOverviewSigId;
let _hidingOverviewSigId;
let _searchControllerSigId;
let _verticalOverview;
let _prevDash;

// constants from settings
let WS_TMB_POSITION;
let WS_TMB_POSITION_ADJUSTMENT
let SEC_WS_TMB_POSITION;
let DASH_POSITION;
let DASH_POSITION_ADJUSTMENT;
let CENTER_DASH_WS;
let CENTER_SEARCH_VIEW;
let CENTER_APP_GRID;
let SHOW_WS_SWITCHER;
let SHOW_WS_SWITCHER_BG;
let APP_GRID_ANIMATION;
let WS_ANIMATION;

let _enabled = false;


function activate() {
    _enabled = true;
    VerticalDash.DashPosition = DashPosition;
    original_MAX_THUMBNAIL_SCALE = WorkspaceThumbnail.MAX_THUMBNAIL_SCALE;

    gOptions = new Settings.Options();
    _updateSettings();
    gOptions.connect('changed', _updateSettings);
    if (Object.keys(verticalOverrides).length != 0)
        reset();

    // switch internal workspace orientation in GS to vertical
    global.workspace_manager.override_workspace_layout(Meta.DisplayCorner.TOPLEFT, false, -1, 1);

    // fix overlay base for vertical workspaces
    verticalOverrides['WorkspaceLayout'] = _Util.overrideProto(Workspace.WorkspaceLayout.prototype, WorkspaceLayoutOverride);
    verticalOverrides['WorkspacesView'] = _Util.overrideProto(WorkspacesView.WorkspacesView.prototype, WorkspacesViewOverride);
    verticalOverrides['WorkspacesDisplay'] = _Util.overrideProto(WorkspacesView.WorkspacesDisplay.prototype, workspacesDisplayOverride);

    // move titles into window previews
    _injectWindowPreview();

    // re-layout overview to better serve for vertical orientation
    verticalOverrides['ThumbnailsBox'] = _Util.overrideProto(WorkspaceThumbnail.ThumbnailsBox.prototype, ThumbnailsBoxOverride);
    verticalOverrides['WorkspaceThumbnail'] = _Util.overrideProto(WorkspaceThumbnail.WorkspaceThumbnail.prototype, WorkspaceThumbnailOverride);
    verticalOverrides['ControlsManager'] = _Util.overrideProto(OverviewControls.ControlsManager.prototype, ControlsManagerOverride);
    verticalOverrides['ControlsManagerLayout'] = _Util.overrideProto(OverviewControls.ControlsManagerLayout.prototype, ControlsManagerLayoutOverride);
    verticalOverrides['SecondaryMonitorDisplay'] = _Util.overrideProto(WorkspacesView.SecondaryMonitorDisplay.prototype, SecondaryMonitorDisplayOverride);
    verticalOverrides['BaseAppView'] = _Util.overrideProto(AppDisplay.BaseAppView.prototype, BaseAppViewOverride);
    verticalOverrides['WindowPreview'] = _Util.overrideProto(WindowPreview.WindowPreview.prototype, WindowPreviewOverride);

    _fixUbuntuDock(gOptions.get('fixUbuntuDock'));

    _prevDash = {};
    const dash = Main.overview.dash;
    _prevDash.dash = dash;
    _prevDash.position = dash.position;
    _shownOverviewSigId = Main.overview.connect('shown', () => {
        // just for case when some other extension changed the value, like Just Perfection when disabled
        WorkspaceThumbnail.MAX_THUMBNAIL_SCALE = gOptions.get('wsThumbnailScale') / 100;

        /*if (global.workspace_manager.layout_rows != -1)
            global.workspace_manager.override_workspace_layout(Meta.DisplayCorner.TOPLEFT, false, -1, 1);*/

        const dash = Main.overview.dash;
        // Move dash above workspaces
        dash.get_parent().set_child_above_sibling(dash, null);
    });

    _hidingOverviewSigId = Main.overview.connect('hiding', () => {
        // Move dash below workspaces before hiding the overview
        const appDisplay = Main.overview._overview.controls._workspacesDisplay;
        const parent = appDisplay.get_parent();
        parent.set_child_above_sibling(appDisplay, null);
    });

    _moveDashAppGridIcon();

    Main.overview.searchEntry.visible = false;
    _searchControllerSigId =  Main.overview._overview.controls._searchController.connect('notify::search-active', _updateSearchEntryVisibility);

    _setAppDisplayOrientation(true);

    // reverse swipe gestures for enter/leave overview and ws switching
    Main.overview._swipeTracker.orientation = Clutter.Orientation.HORIZONTAL;

    // switch PageUp/PageDown workspace switcher shortcuts
    _switchPageShortcuts();

    // set Dash orientation
    _updateDashPosition();

    // fix for upstream bug - overview always shows workspace 1 instead of the active one after restart
    Main.overview._overview._controls._workspaceAdjustment.set_value(global.workspace_manager.get_active_workspace_index());

}

function reset() {
    _enabled = false;

    _fixUbuntuDock(false);

    // switch workspace orientation back to horizontal
    global.workspace_manager.override_workspace_layout(Meta.DisplayCorner.TOPLEFT, false, 1, -1);

    if (original_MAX_THUMBNAIL_SCALE)
        WorkspaceThumbnail.MAX_THUMBNAIL_SCALE = original_MAX_THUMBNAIL_SCALE;

    if (_shownOverviewSigId) {
        Main.overview.disconnect(_shownOverviewSigId);
        _shownOverviewSigId = 0;
    }

    if (_hidingOverviewSigId) {
        Main.overview.disconnect(_hidingOverviewSigId);
        _hidingOverviewSigId = 0;
    }

    if (_searchControllerSigId) {
        Main.overview._overview.controls._searchController.disconnect(_searchControllerSigId);
        _searchControllerSigId = 0;
    }

    for (let name in _windowPreviewInjections) {
        _Util.removeInjection(WindowPreview.WindowPreview.prototype, _windowPreviewInjections, name);
    }
    _windowPreviewInjections = {};

    _Util.overrideProto(WorkspacesView.WorkspacesView.prototype, verticalOverrides['WorkspacesView']);
    _Util.overrideProto(WorkspacesView.WorkspacesDisplay.prototype, verticalOverrides['WorkspacesDisplay']);
    _Util.overrideProto(WorkspacesView.SecondaryMonitorDisplay.prototype, verticalOverrides['SecondaryMonitorDisplay']);

    _Util.overrideProto(WorkspaceThumbnail.ThumbnailsBox.prototype, verticalOverrides['ThumbnailsBox']);
    _Util.overrideProto(WorkspaceThumbnail.WorkspaceThumbnail.prototype, verticalOverrides['WorkspaceThumbnail']);
    _Util.overrideProto(OverviewControls.ControlsManagerLayout.prototype, verticalOverrides['ControlsManagerLayout']);
    _Util.overrideProto(OverviewControls.ControlsManager.prototype, verticalOverrides['ControlsManager']);
    _Util.overrideProto(Workspace.WorkspaceLayout.prototype, verticalOverrides['WorkspaceLayout']);
    _Util.overrideProto(AppDisplay.BaseAppView.prototype, verticalOverrides['BaseAppView']);
    _Util.overrideProto(WindowPreview.WindowPreview.prototype, verticalOverrides['WindowPreview']);

    Main.overview._swipeTracker.orientation = Clutter.Orientation.VERTICAL;

    verticalOverrides = {}

    _setAppDisplayOrientation(false);

    Main.overview.dash.visible = true;
    Main.overview.dash._background.opacity = 255;
    Main.overview.searchEntry.visible = true;
    Main.overview.searchEntry.opacity = 255;

    const reset = true;
    _moveDashAppGridIcon(reset);
    _prevDash = null;

    // switch PageUp/PageDown workspace switcher shortcuts
    _switchPageShortcuts();

    // remove Dash overrides if needed
    VerticalDash.reset();

    gOptions.destroy();
    gOptions = null;
}

function _resetExtension(timeout = 200) {
    if (_resetTimeoutId)
        GLib.source_remove(_resetTimeoutId);
    _resetTimeoutId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        timeout,
        () => {
            if (!_enabled)
                return;
            const dash = Main.overview.dash;
            if (dash !== _prevDash) {
                log(`[${Me.metadata.name}]: Dash has been replaced, resetting...`);
                reset();
                activate();
                _prevDash = dash;
            }
            _resetTimeoutId = 0;
            return GLib.SOURCE_REMOVE;
        }
    );
}

function _fixUbuntuDock(activate = true) {
    // Workaround for Ubuntu Dock breaking overview allocations after changing monitor configuration and deactivating dock
    if (_shellSettings && _watchDockSigId) {
        _shellSettings.disconnect(_watchDockSigId);
        _watchDockSigId = 0;
    }
    _shellSettings = null;

    if (_resetTimeoutId) {
        GLib.source_remove(_resetTimeoutId);
        _resetTimeoutId = 0;
    }

    if (_monitorsChangedSigId) {
        Main.layoutManager.disconnect(_monitorsChangedSigId);
        _monitorsChangedSigId = 0;
    }
    _resetExtensionIfEnabled = () => {};

    if (_showingOverviewSigId) {
        Main.overview.disconnect(_showingOverviewSigId);
        _showingOverviewSigId = 0;
    }

    if (!activate)
        return;

    _monitorsChangedSigId = Main.layoutManager.connect('monitors-changed', () => _resetExtension(3000));
    _shellSettings = ExtensionUtils.getSettings( 'org.gnome.shell');
    _watchDockSigId = _shellSettings.connect('changed::enabled-extensions', () => _resetExtension());
    _resetExtensionIfEnabled = _resetExtension;
    _showingOverviewSigId = Main.overview.connect('showing', () => {
        // workaround for Ubuntu Dock breaking overview allocations after changing position
        const dash = Main.overview.dash;
         if (_prevDash.dash !== dash || _prevDash.position !== dash._position) {
             _resetExtensionIfEnabled(0);
         }
     });
}

//*************************************************************************************************

function _updateSettings(settings, key) {
    WorkspaceThumbnail.MAX_THUMBNAIL_SCALE = gOptions.get('wsThumbnailScale', true) / 100;
    WS_TMB_POSITION = gOptions.get('workspaceThumbnailsPosition', true);
    WS_TMB_POSITION_ADJUSTMENT = gOptions.get('wsTmbPositionAdjust', true) * -1 / 100; // range 1 to -1
    SEC_WS_TMB_POSITION = gOptions.get('secondaryWsThumbnailsPosition', true);
    VerticalDash.MAX_ICON_SIZE = VerticalDash.baseIconSizes[gOptions.get('dashMaxIconSize', true)];
    DASH_POSITION = gOptions.get('dashPosition', true);
    if (DASH_POSITION >= DashPosition.length) {
        DASH_POSITION = DashPosition.BOTTOM;
        gOptions.set('dashPosition', DASH_POSITION);
    }
    VerticalDash.DASH_POSITION = DASH_POSITION;
    DASH_POSITION_ADJUSTMENT = gOptions.get('dashPositionAdjust', true);
    DASH_POSITION_ADJUSTMENT = DASH_POSITION_ADJUSTMENT * -1 / 100; // range 1 to -1
    CENTER_DASH_WS = gOptions.get('centerDashToWs', true);
    CENTER_SEARCH_VIEW = gOptions.get('centerSearch', true);
    CENTER_APP_GRID = gOptions.get('centerAppGrid', true);
    SHOW_WS_SWITCHER = gOptions.get('showWsSwitcher', true);
    SHOW_WS_SWITCHER_BG = gOptions.get('showWsSwitcherBg', true) && SHOW_WS_SWITCHER;
    APP_GRID_ANIMATION = gOptions.get('appGridAnimation', true);
    if (APP_GRID_ANIMATION === 4) APP_GRID_ANIMATION = (!(WS_TMB_POSITION % 2) || !SHOW_WS_SWITCHER) ? 1 : 2;
    WS_ANIMATION = gOptions.get('workspaceAnimation', true);

    Main.overview.dash._background.opacity = Math.round(gOptions.get('dashBgOpacity', true) * 2.5); // conversion % to 0-255
    Main.overview.dash.visible = gOptions.get('showDash', true);

    _switchPageShortcuts();
    if (key === 'fix-ubuntu-dock')
        _fixUbuntuDock(gOptions.get('fixUbuntuDock', true));
    if (key === 'show-app-icon-position')
        _moveDashAppGridIcon();
    if (key === 'dash-position')
        _updateDashPosition();
    if (key === 'dash-max-icon-size')
        Main.overview.dash._redisplay();
}

function _updateDashPosition() {
    switch (DASH_POSITION) {
    case DashPosition.TOP:
    case DashPosition.BOTTOM:
        //VerticalDash.reset();
        const horizontal = true;
        VerticalDash.override(horizontal);
        VerticalDash.gOptions = null;
        break;
    case DashPosition.LEFT:
    case DashPosition.RIGHT:
        VerticalDash.gOptions = gOptions;
        VerticalDash.override();
        break;
    default:
        VerticalDash.reset();
    }
    Main.overview.dash._redisplay();
}

function _updateSearchEntryVisibility() {
    // show search entry only if the user starts typing, and hide it when leaving the search mode
    const searchActive = Main.overview._overview.controls._searchController._searchActive;
    Main.overview.searchEntry.ease({
        opacity: searchActive ? 255 : 0,
        duration: OverviewControls.SIDE_CONTROLS_ANIMATION_TIME,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: () => (Main.overview.searchEntry.visible = searchActive),
    });
}

function _switchPageShortcuts() {
    if (!gOptions.get('enablePageShortcuts'))
        return;

    const vertical = global.workspaceManager.layout_rows === -1;
    const schema  = 'org.gnome.desktop.wm.keybindings';
    const settings = ExtensionUtils.getSettings(schema);

    const keyLeft = 'switch-to-workspace-left';
    const keyRight = 'switch-to-workspace-right';
    const keyUp = 'switch-to-workspace-up';
    const keyDown = 'switch-to-workspace-down';

    const keyMoveLeft = 'move-to-workspace-left';
    const keyMoveRight = 'move-to-workspace-right';
    const keyMoveUp = 'move-to-workspace-up';
    const keyMoveDown = 'move-to-workspace-down';

    const switchPrevSc = '<Super>Page_Up';
    const switchNextSc = '<Super>Page_Down';
    const movePrevSc = '<Super><Shift>Page_Up';
    const moveNextSc = '<Super><Shift>Page_Down';

    let switchLeft = settings.get_strv(keyLeft);
    let switchRight = settings.get_strv(keyRight);
    let switchUp = settings.get_strv(keyUp);
    let switchDown = settings.get_strv(keyDown);

    let moveLeft = settings.get_strv(keyMoveLeft);
    let moveRight = settings.get_strv(keyMoveRight);
    let moveUp = settings.get_strv(keyMoveUp);
    let moveDown = settings.get_strv(keyMoveDown);

    if (vertical) {
        switchLeft.includes(switchPrevSc)  && switchLeft.splice(switchLeft.indexOf(switchPrevSc), 1);
        switchRight.includes(switchNextSc) && switchRight.splice(switchRight.indexOf(switchNextSc), 1);
        moveLeft.includes(movePrevSc)      && moveLeft.splice(moveLeft.indexOf(movePrevSc), 1);
        moveRight.includes(moveNextSc)     && moveRight.splice(moveRight.indexOf(moveNextSc), 1);

        switchUp.includes(switchPrevSc)    || switchUp.push(switchPrevSc);
        switchDown.includes(switchNextSc)  || switchDown.push(switchNextSc);
        moveUp.includes(movePrevSc)        || moveUp.push(movePrevSc);
        moveDown.includes(moveNextSc)      || moveDown.push(moveNextSc);
    } else {
        switchLeft.includes(switchPrevSc)  || switchLeft.push(switchPrevSc);
        switchRight.includes(switchNextSc) || switchRight.push(switchNextSc);
        moveLeft.includes(movePrevSc)      || moveLeft.push(movePrevSc);
        moveRight.includes(moveNextSc)     || moveRight.push(moveNextSc);

        switchUp.includes(switchPrevSc)    && switchUp.splice(switchUp.indexOf(switchPrevSc), 1);
        switchDown.includes(switchNextSc)  && switchDown.splice(switchDown.indexOf(switchNextSc), 1);
        moveUp.includes(movePrevSc)        && moveUp.splice(moveUp.indexOf(movePrevSc), 1);
        moveDown.includes(moveNextSc)      && moveDown.splice(moveDown.indexOf(moveNextSc), 1);
    }

    settings.set_strv(keyLeft, switchLeft);
    settings.set_strv(keyRight, switchRight);
    settings.set_strv(keyUp, switchUp);
    settings.set_strv(keyDown, switchDown);

    settings.set_strv(keyMoveLeft, moveLeft);
    settings.set_strv(keyMoveRight, moveRight);
    settings.set_strv(keyMoveUp, moveUp);
    settings.set_strv(keyMoveDown, moveDown);
}

//----- WindowPreview ------------------------------------------------------------------

function _injectWindowPreview() {
    _windowPreviewInjections['_init'] = _Util.injectToFunction(
        WindowPreview.WindowPreview.prototype, '_init', function() {
            this._title.get_constraints()[1].offset = - 1.3 * WindowPreview.ICON_SIZE;
            this.set_child_above_sibling(this._title, null);
        }
    );
}

//----- AppDisplay -------------------------------------------------------------------
function _setAppDisplayOrientation(vertical = false) {
    const CLUTTER_ORIENTATION = vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL;
    const scroll = vertical ? 'vscroll' : 'hscroll';
    // app display to vertical has issues - page indicator not working
    // global appDisplay orientation switch is not built-in
    let appDisplay = Main.overview._overview._controls._appDisplay;
    // following line itself only changes in which axis will operate overshoot detection which switches appDisplay pages while dragging app icon to vertical
    appDisplay._orientation = CLUTTER_ORIENTATION;
    appDisplay._grid.layoutManager._orientation = CLUTTER_ORIENTATION;
    appDisplay._swipeTracker.orientation = CLUTTER_ORIENTATION;
    if (vertical) {
        appDisplay._scrollView.set_policy(St.PolicyType.NEVER, St.PolicyType.EXTERNAL);
    } else {
        appDisplay._scrollView.set_policy(St.PolicyType.EXTERNAL, St.PolicyType.NEVER);
        if (_appDisplayScrollConId) {
            appDisplay._adjustment.disconnect(_appDisplayScrollConId);
            _appDisplayScrollConId = 0;
        }
    }

    // vertical page indicator is not practical in given configuration...
    //appDisplay._pageIndicators.vertical = true;

    // value for page indicator is calculated from scroll adjustment, horizontal needs to be replaced by vertical
    appDisplay._adjustment = appDisplay._scrollView[scroll].adjustment;

    // no need to connect already connected signal (wasn't removed the original one before)
    if (!vertical) {
        // reset used appdisplay properties
        Main.overview._overview._controls._appDisplay.scale_y = 1;
        Main.overview._overview._controls._appDisplay.scale_x = 1;
        Main.overview._overview._controls._appDisplay.opacity = 255;
        return;
    }

    _appDisplayScrollConId = appDisplay._adjustment.connect('notify::value', adj => {
        appDisplay._updateFade();
        const value = adj.value / adj.page_size;
        appDisplay._pageIndicators.setCurrentPosition(value);

        const distanceToPage = Math.abs(Math.round(value) - value);
        if (distanceToPage < 0.001) {
            appDisplay._hintContainer.opacity = 255;
            appDisplay._hintContainer.translationX = 0;
        } else {
            appDisplay._hintContainer.remove_transition('opacity');
            let opacity = Math.clamp(
                255 * (1 - (distanceToPage * 2)),
                0, 255);

            appDisplay._hintContainer.translationX = (Math.round(value) - value) * adj.page_size;
            appDisplay._hintContainer.opacity = opacity;
        }
    });
}

function _moveDashAppGridIcon(reset = false) {
    // move dash app grid icon to the front
    const dash = Main.overview.dash;
    if (reset || gOptions.get('showAppsIconPosition', true))
        dash._dashContainer.set_child_at_index(dash._showAppsIcon, 1);
    else
        dash._dashContainer.set_child_at_index(dash._showAppsIcon, 0);
}

// ---- workspacesView ----------------------------------------
// WorkspacesView
var WorkspacesViewOverride = {
    _getFirstFitSingleWorkspaceBox: function(box, spacing, vertical) {
        let [width, height] = box.get_size();
        const [workspace] = this._workspaces;

        const rtl = this.text_direction === Clutter.TextDirection.RTL;
        const adj = this._scrollAdjustment;
        const currentWorkspace = vertical || !rtl
            ? adj.value : adj.upper - adj.value - 1;

        // Single fit mode implies centered too
        let [x1, y1] = box.get_origin();
        const [, workspaceWidth] = workspace ? workspace.get_preferred_width(Math.floor(height)) : [,width];
        const [, workspaceHeight] = workspace ? workspace.get_preferred_height(workspaceWidth) : [,height];

        if (vertical) {
            x1 += (width - workspaceWidth) / 2;
            y1 -= currentWorkspace * (workspaceHeight + spacing);
        } else {
            x1 += (width - workspaceWidth) / 2;
            x1 -= currentWorkspace * (workspaceWidth + spacing);
        }

        const fitSingleBox = new Clutter.ActorBox({x1, y1});

        fitSingleBox.set_size(workspaceWidth, workspaceHeight);

        return fitSingleBox;
    },

    // avoid overlapping of adjacent workspaces with the current view
    _getSpacing: function(box, fitMode, vertical) {
        const [width, height] = box.get_size();
        const [workspace] = this._workspaces;

        if (!workspace) return;

        let availableSpace;
        let workspaceSize;
        if (vertical) {
            [, workspaceSize] = workspace.get_preferred_height(width);
            availableSpace = height;
        } else {
            [, workspaceSize] = workspace.get_preferred_width(height);
            availableSpace = (width - workspaceSize) / 2;
        }

        const spacing = (availableSpace - workspaceSize * 0.4) * (1 - fitMode);
        const { scaleFactor } = St.ThemeContext.get_for_stage(global.stage);

        return Math.clamp(spacing, WORKSPACE_MIN_SPACING * scaleFactor,
            WORKSPACE_MAX_SPACING * scaleFactor);
    },

    // this function has duplicate in OverviewControls so we use one function for both to avoid issues with syncing them
    _getFitModeForState: function(state) {
        return _getFitModeForState(state);
    },

    // mormal view 0, spread windows 1
    _getWorkspaceModeForOverviewState: function(state) {
        const { ControlsState } = OverviewControls;

        switch (state) {
        case ControlsState.HIDDEN:
            return 0;
        case ControlsState.WINDOW_PICKER:
            return 1;
        case ControlsState.APP_GRID:
            return ((this._monitorIndex !== global.display.get_primary_monitor()) || WS_ANIMATION === 0) ? 1 : 0;
        }

        return 0;
    },

    // disable scaling and hide inactive workspaces
    _updateWorkspacesState: function() {
        const adj = this._scrollAdjustment;
        const fitMode = this._fitModeAdjustment.value;

        const { initialState, finalState, progress } =
            this._overviewAdjustment.getStateTransitionParams();

        const workspaceMode = (1 - fitMode) * Util.lerp(
            this._getWorkspaceModeForOverviewState(initialState),
            this._getWorkspaceModeForOverviewState(finalState),
            progress);

        // Fade and scale inactive workspaces
        this._workspaces.forEach((w, index) => {
            w.stateAdjustment.value = workspaceMode;

            const distanceToCurrentWorkspace = Math.abs(adj.value - index);

            const scaleProgress = 1 - Math.clamp(distanceToCurrentWorkspace, 0, 1);

            //const scale = Util.lerp(1, 1, scaleProgress);//Util.lerp(WORKSPACE_INACTIVE_SCALE, 1, scaleProgress);
            //w.set_scale(scale, scale);

            // if we disable inactive workspaces, ws animation will be noticably smoother
            // the only drawback is, that windows on inactive workspaces will be spread with the first ws switching in the overview
            // so you'll see the spread animation during the first workspace switching animation
            w.visible = scaleProgress ? true : false;
            //w.opacity = scaleProgress ? 255 : 0;
        });
    }
}

var workspacesDisplayOverride = {
    _updateWorkspacesViews: function() {
        for (let i = 0; i < this._workspacesViews.length; i++)
            this._workspacesViews[i].destroy();

        this._primaryIndex = Main.layoutManager.primaryIndex;
        this._workspacesViews = [];
        let monitors = Main.layoutManager.monitors;
        for (let i = 0; i < monitors.length; i++) {
            let view;
            if (i === this._primaryIndex) {
                view = new WorkspacesView.WorkspacesView(i,
                    this._controls,
                    this._scrollAdjustment,
                    this._fitModeAdjustment,
                    this._overviewAdjustment);

                view.visible = this._primaryVisible;
                this.bind_property('opacity', view, 'opacity', GObject.BindingFlags.SYNC_CREATE);
                this.add_child(view);
            } else {
                view = new WorkspacesView.SecondaryMonitorDisplay(i,
                    this._controls,
                    this._scrollAdjustment,
                    // Secondary monitors don't need FitMode.ALL since there is workspace switcher always visible
                    //this._fitModeAdjustment,
                    new St.Adjustment({
                        actor: this,
                        value: 0,//FitMode.SINGLE,
                        lower: 0,//FitMode.SINGLE,
                        upper: 0,//FitMode.SINGLE,
                    }),
                    this._overviewAdjustment);
                Main.layoutManager.overviewGroup.add_actor(view);
            }

            this._workspacesViews.push(view);
        }
    }
}

// common for OverviewControls and Vertical Workspaces
function _getFitModeForState(state) {
    switch (state) {
    case ControlsState.HIDDEN:
    case ControlsState.WINDOW_PICKER:
        return WorkspacesView.FitMode.SINGLE;
    case ControlsState.APP_GRID:
        if ((WS_ANIMATION === 1) && SHOW_WS_SWITCHER)
            return WorkspacesView.FitMode.ALL;
        else
            return WorkspacesView.FitMode.SINGLE;
    default:
        return WorkspacesView.FitMode.SINGLE;
    }
}

// WindowPreview
var WindowPreviewOverride = {
    _updateIconScale: function() {
        const { currentState, initialState, finalState } =
            this._overviewAdjustment.getStateTransitionParams();

        // Current state - 0 - HIDDEN, 1 - WINDOW_PICKER, 2 - APP_GRID
        const primaryMonitor = this.metaWindow.get_monitor() === global.display.get_primary_monitor();

        const visible =
            (initialState > ControlsState.HIDDEN || finalState > ControlsState.HIDDEN)
            && !(finalState === ControlsState.APP_GRID && primaryMonitor);

        let scale = visible
            ? (currentState >= 1 ? 1 : currentState % 1) : 0;
        if (!primaryMonitor &&
            ((initialState === ControlsState.WINDOW_PICKER && finalState === ControlsState.APP_GRID) ||
            (initialState === ControlsState.APP_GRID && finalState === ControlsState.WINDOW_PICKER))
            ) {

            scale = 1;
        } else if (primaryMonitor && ((initialState === ControlsState.WINDOW_PICKER && finalState === ControlsState.APP_GRID) ||
            initialState === ControlsState.APP_GRID && finalState === ControlsState.HIDDEN)) {
            scale = 0;
        }
        this._icon.set({
            scale_x: scale,
            scale_y: scale,
        });

        // if titles are in 'always show' mode (set by another extension), we need to add transition between visible/invisible state
        this._title.set({
            opacity: scale * 255
        });
    }
}

//  SecondaryMonitorDisplay
var SecondaryMonitorDisplayOverride = {
    _getThumbnailParamsForState: function(state) {
        const { ControlsState } = OverviewControls;

        let opacity, scale;
        switch (state) {
        case ControlsState.HIDDEN:
        case ControlsState.WINDOW_PICKER:
        case ControlsState.APP_GRID:
            opacity = 255;
            scale = 1;
            break;
        default:
            opacity = 255;
            scale = 1;
            break;
        }

        return { opacity, scale };
    },

    _getThumbnailsWidth: function(box, spacing) {
        if (!this._thumbnails.visible)
            return 0;

        const [width, height] = box.get_size();
        const { expandFraction } = this._thumbnails;
        const [, thumbnailsWidth] = this._thumbnails.get_preferred_custom_width(height - 2 * spacing);
        return Math.min(
            thumbnailsWidth * expandFraction,
            width * WorkspaceThumbnail.MAX_THUMBNAIL_SCALE);
    },

    _getWorkspacesBoxForState: function(state, box, padding, thumbnailsWidth, spacing) {
        const { ControlsState } = OverviewControls;
        const workspaceBox = box.copy();
        const [width, height] = workspaceBox.get_size();

        switch (state) {
        case ControlsState.HIDDEN:
            break;
        case ControlsState.WINDOW_PICKER:
        case ControlsState.APP_GRID:
            let wsbX;
            if (this._thumbnails._positionLeft) {
                wsbX = 2 * spacing + thumbnailsWidth;
            } else {
                wsbX = spacing;
            }
            const wWidth = width - thumbnailsWidth - 5 * spacing;
            const wHeight = Math.min(wWidth / (width / height), height - 1.7 * padding);
            workspaceBox.set_origin(wsbX, (height - wHeight) / 2);
            workspaceBox.set_size(wWidth, wHeight);
            break;
        }

        return workspaceBox;
    },

    vfunc_allocate: function(box) {
        this.set_allocation(box);

        const themeNode = this.get_theme_node();
        const contentBox = themeNode.get_content_box(box);
        const [width, height] = contentBox.get_size();
        const { expandFraction } = this._thumbnails;
        const spacing = themeNode.get_length('spacing') * expandFraction;
        const padding = Math.round((1 - WorkspacesView.SECONDARY_WORKSPACE_SCALE) * height / 2);

        let thumbnailsWidth = this._getThumbnailsWidth(contentBox, spacing);
        let [, thumbnailsHeight] = this._thumbnails.get_preferred_custom_height(thumbnailsWidth);

        this._thumbnails.visible = SHOW_WS_SWITCHER;
        if (this._thumbnails.visible) {
            // 2 - default, 0 - left, 1 - right
            let wsTmbPosition = SEC_WS_TMB_POSITION;
            if (wsTmbPosition === 2) // default - copy primary monitor option
                wsTmbPosition = WS_TMB_POSITION % 2; // 0,2 - left, 1,3 right

            let wsTmbX;
            if (wsTmbPosition) {
                wsTmbX = width - spacing - thumbnailsWidth;
                this._thumbnails._positionLeft = false;
            } else {
                wsTmbX = spacing;
                this._thumbnails._positionLeft = true;
            }

            const childBox = new Clutter.ActorBox();
            const availSpace = height - thumbnailsHeight;

            let wsTmbY =  Math.max(spacing, availSpace / 2);

            childBox.set_origin(wsTmbX, wsTmbY);
            childBox.set_size(thumbnailsWidth, thumbnailsHeight);
            this._thumbnails.allocate(childBox);
        }

        const {
            currentState, initialState, finalState, transitioning, progress,
        } = this._overviewAdjustment.getStateTransitionParams();

        let workspacesBox;
        const workspaceParams = [contentBox, padding, thumbnailsWidth, spacing];
        if (!transitioning) {
            workspacesBox =
                this._getWorkspacesBoxForState(currentState, ...workspaceParams);
        } else {
            const initialBox =
                this._getWorkspacesBoxForState(initialState, ...workspaceParams);
            const finalBox =
                this._getWorkspacesBoxForState(finalState, ...workspaceParams);
            workspacesBox = initialBox.interpolate(finalBox, progress);
        }
        this._workspacesView.allocate(workspacesBox);
    },

    _updateThumbnailVisibility: function() {
        const visible = !this._settings.get_boolean('workspaces-only-on-primary');

        if (this._thumbnails.visible === visible)
            return;

        this._thumbnails.show();
        this._updateThumbnailParams();
        this._thumbnails.ease_property('expand-fraction', visible ? 1 : 0, {
            duration: OverviewControls.SIDE_CONTROLS_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._thumbnails.visible = visible;
                this._thumbnails._indicator.visible = visible;
            },
        });
    },

    _updateWorkspacesView: function() {
        if (this._workspacesView)
            this._workspacesView.destroy();

        if (this._settings.get_boolean('workspaces-only-on-primary')) {
            this._workspacesView = new WorkspacesView.ExtraWorkspaceView(
                this._monitorIndex,
                this._overviewAdjustment);
        } else {
            this._workspacesView = new WorkspacesView.WorkspacesView(
                this._monitorIndex,
                this._controls,
                this._scrollAdjustment,
                // Secondary monitors don't need FitMode.ALL since there is workspace switcher always visible
                //this._fitModeAdjustment,
                new St.Adjustment({
                    actor: this,
                    value: 0,//FitMode.SINGLE,
                    lower: 0,//FitMode.SINGLE,
                    upper: 0,//FitMode.SINGLE,
                }),
                //secondaryOverviewAdjustment);
                this._overviewAdjustment);
        }
        this.add_child(this._workspacesView);
    }
}

//------workspaceThumbnail------------------------------------------------------------------------
Background.FADE_ANIMATION_TIME = 0;
// WorkspaceThumbnail
var WorkspaceThumbnailOverride = {
    after__init: function () {

        //radius of ws thumbnail backgroung
        this.set_style('border-radius: 8px;');

        if (!SHOW_WS_SWITCHER_BG)
            return;
        this._bgManager = new Background.BackgroundManager({
            monitorIndex: this.monitorIndex,
            container: this._viewport,
            vignette: false,
            controlPosition: false,
        });

        this._viewport.set_child_below_sibling(this._bgManager.backgroundActor, null);

        this.connect('destroy', function () {
            if (this._bgManager)
                this._bgManager.destroy();
            this._bgManager = null;
        }.bind(this));

        //this._bgManager.backgroundActor.opacity = 100;

        // this all is just for the small border radius...
        const { scaleFactor } = St.ThemeContext.get_for_stage(global.stage);
        const cornerRadius = scaleFactor * BACKGROUND_CORNER_RADIUS_PIXELS;
        const backgroundContent = this._bgManager.backgroundActor.content;
        backgroundContent.rounded_clip_radius = cornerRadius;

        // the original clip has some addition at the bottom
        const rect = new Graphene.Rect();
        rect.origin.x = this._viewport.x;
        rect.origin.y = this._viewport.y;
        rect.size.width = this._viewport.width;
        rect.size.height = this._viewport.height;

        this._bgManager.backgroundActor.content.set_rounded_clip_bounds(rect);
    }
}

// ThumbnailsBox
var ThumbnailsBoxOverride = {
    _activateThumbnailAtPoint: function(stageX, stageY, time) {
        const [r_, x, y] = this.transform_stage_point(stageX, stageY);

        const thumbnail = this._thumbnails.find(t => y >= t.y && y <= t.y + t.height);
        if (thumbnail)
            thumbnail.activate(time);
    },

    _getPlaceholderTarget: function(index, spacing, rtl) {
        const workspace = this._thumbnails[index];

        let targetY1;
        let targetY2;

        if (rtl) {
            const baseY = workspace.y + workspace.height;
            targetY1 = baseY - WORKSPACE_CUT_SIZE;
            targetY2 = baseY + spacing + WORKSPACE_CUT_SIZE;
        } else {
            targetY1 = workspace.y - spacing - WORKSPACE_CUT_SIZE;
            targetY2 = workspace.y + WORKSPACE_CUT_SIZE;
        }

        if (index === 0) {
            if (rtl)
                targetY2 -= spacing + WORKSPACE_CUT_SIZE;
            else
                targetY1 += spacing + WORKSPACE_CUT_SIZE;
        }

        if (index === this._dropPlaceholderPos) {
            const placeholderHeight = this._dropPlaceholder.get_height() + spacing;
            if (rtl)
                targetY2 += placeholderHeight;
            else
                targetY1 -= placeholderHeight;
        }

        return [targetY1, targetY2];
    },

     _withinWorkspace: function(y, index, rtl) {
        const length = this._thumbnails.length;
        const workspace = this._thumbnails[index];

        let workspaceY1 = workspace.y + WORKSPACE_CUT_SIZE;
        let workspaceY2 = workspace.y + workspace.height - WORKSPACE_CUT_SIZE;

        if (index === length - 1) {
            if (rtl)
                workspaceY1 -= WORKSPACE_CUT_SIZE;
            else
                workspaceY2 += WORKSPACE_CUT_SIZE;
        }

        return y > workspaceY1 && y <= workspaceY2;
    },

    handleDragOver: function(source, actor, x, y, time) {
        if (!source.metaWindow &&
            (!source.app || !source.app.can_open_new_window()) &&
            (source.app || !source.shellWorkspaceLaunch) &&
            source != Main.xdndHandler)
            return DND.DragMotionResult.CONTINUE;

        const rtl = Clutter.get_default_text_direction() === Clutter.TextDirection.RTL;
        let canCreateWorkspaces = Meta.prefs_get_dynamic_workspaces();
        let spacing = this.get_theme_node().get_length('spacing');

        this._dropWorkspace = -1;
        let placeholderPos = -1;
        let length = this._thumbnails.length;
        for (let i = 0; i < length; i++) {
            const index = rtl ? length - i - 1 : i;

            if (canCreateWorkspaces && source !== Main.xdndHandler) {
                const [targetStart, targetEnd] =
                    this._getPlaceholderTarget(index, spacing, rtl);

                if (y > targetStart && y <= targetEnd) {
                    placeholderPos = index;
                    break;
                }
            }

            if (this._withinWorkspace(y, index, rtl)) {
                this._dropWorkspace = index;
                break;
            }
        }

        if (this._dropPlaceholderPos != placeholderPos) {
            this._dropPlaceholderPos = placeholderPos;
            this.queue_relayout();
        }

        if (this._dropWorkspace != -1)
            return this._thumbnails[this._dropWorkspace].handleDragOverInternal(source, actor, time);
        else if (this._dropPlaceholderPos != -1)
            return source.metaWindow ? DND.DragMotionResult.MOVE_DROP : DND.DragMotionResult.COPY_DROP;
        else
            return DND.DragMotionResult.CONTINUE;
    },

    //vfunc_get_preferred_width: function(forHeight) {
    // override of this vfunc doesn't work for some reason (tested on Ubuntu and Fedora), it's not reachable
    get_preferred_custom_width: function(forHeight) {
        if (forHeight === -1)
            return this.get_preferred_custom_height(forHeight);

        let themeNode = this.get_theme_node();

        forHeight = themeNode.adjust_for_width(forHeight);

        let spacing = themeNode.get_length('spacing');
        let nWorkspaces = this._thumbnails.length;
        let totalSpacing = (nWorkspaces - 1) * spacing;

        const avail = forHeight - totalSpacing;

        let scale = (avail / nWorkspaces) / this._porthole.height;
        scale = Math.min(scale, WorkspaceThumbnail.MAX_THUMBNAIL_SCALE);

        const width = Math.round(this._porthole.width * scale);

        return themeNode.adjust_preferred_width(width, width);
    },

    get_preferred_custom_height: function(_forWidth) {
        // Note that for getPreferredHeight/Width we cheat a bit and skip propagating
        // the size request to our children because we know how big they are and know
        // that the actors aren't depending on the virtual functions being called.
        let themeNode = this.get_theme_node();

        let spacing = themeNode.get_length('spacing');
        let nWorkspaces = this._thumbnails.length;

        let totalSpacing = (nWorkspaces - 1) * spacing;

        const ratio = this._porthole.width / this._porthole.height;
        const tmbHeight = _forWidth / ratio;

        const naturalheight = this._thumbnails.reduce((accumulator, thumbnail, index) => {
            let workspaceSpacing = 0;

            const progress = 1 - thumbnail.collapse_fraction;
            //const height = (this._porthole.height * WorkspaceThumbnail.MAX_THUMBNAIL_SCALE + workspaceSpacing) * progress;
            const height = (tmbHeight) * progress;
            return accumulator + height;
        }, 0);

        //return themeNode.adjust_preferred_height(totalSpacing, naturalheight);
        // we need to calculate the height precisely as it need to align with the workspacesDisplay because of transition animation
        // This works perfectly for fullHD monitor, for some reason 5:4 aspect ratio monitor adds unnecessary pixels to the final height of the thumbnailsBox
        return [totalSpacing, naturalheight];
    },

    vfunc_allocate: function(box) {
        this.set_allocation(box);

        let rtl = Clutter.get_default_text_direction() == Clutter.TextDirection.RTL;

        if (this._thumbnails.length == 0) // not visible
            return;

        let themeNode = this.get_theme_node();
        box = themeNode.get_content_box(box);

        const portholeWidth = this._porthole.width;
        const portholeHeight = this._porthole.height;
        const spacing = themeNode.get_length('spacing');

        const nWorkspaces = this._thumbnails.length;

        // Compute the scale we'll need once everything is updated,
        // unless we are currently transitioning
        if (this._expandFraction === 1) {
            const totalSpacing = (nWorkspaces - 1) * spacing;
            const availableHeight = (box.get_height() - totalSpacing) / nWorkspaces;

            const hScale = box.get_width() / portholeWidth;
            const vScale = availableHeight / portholeHeight;
            const newScale = Math.min(hScale, vScale);

            if (newScale !== this._targetScale) {
                if (this._targetScale > 0) {
                    // We don't ease immediately because we need to observe the
                    // ordering in queueUpdateStates - if workspaces have been
                    // removed we need to slide them out as the first thing.
                    this._targetScale = newScale;
                    this._pendingScaleUpdate = true;
                } else {
                    this._targetScale = this._scale = newScale;
                }

                this._queueUpdateStates();
            }
        }

        const ratio = portholeWidth / portholeHeight;
        const thumbnailFullHeight = Math.round(portholeHeight * this._scale);
        const thumbnailWidth = Math.round(thumbnailFullHeight * ratio);
        const thumbnailHeight = thumbnailFullHeight * this._expandFraction;
        const roundedVScale = thumbnailHeight / portholeHeight;

        let indicatorValue = this._scrollAdjustment.value;
        let indicatorUpperWs = Math.ceil(indicatorValue);
        let indicatorLowerWs = Math.floor(indicatorValue);

        let indicatorLowerY1 = 0;
        let indicatorLowerY2 = 0;
        let indicatorUpperY1 = 0;
        let indicatorUpperY2 = 0;

        let indicatorThemeNode = this._indicator.get_theme_node();
        let indicatorTopFullBorder = indicatorThemeNode.get_padding(St.Side.TOP) + indicatorThemeNode.get_border_width(St.Side.TOP);
        let indicatorBottomFullBorder = indicatorThemeNode.get_padding(St.Side.BOTTOM) + indicatorThemeNode.get_border_width(St.Side.BOTTOM);
        let indicatorLeftFullBorder = indicatorThemeNode.get_padding(St.Side.LEFT) + indicatorThemeNode.get_border_width(St.Side.LEFT);
        let indicatorRightFullBorder = indicatorThemeNode.get_padding(St.Side.RIGHT) + indicatorThemeNode.get_border_width(St.Side.RIGHT);

        let y = box.y1;

        if (this._dropPlaceholderPos == -1) {
            this._dropPlaceholder.allocate_preferred_size(
                ...this._dropPlaceholder.get_position());

            Meta.later_add(Meta.LaterType.BEFORE_REDRAW, () => {
                this._dropPlaceholder.hide();
            });
        }

        let childBox = new Clutter.ActorBox();

        for (let i = 0; i < this._thumbnails.length; i++) {
            const thumbnail = this._thumbnails[i];
            if (i > 0)
                y += spacing - Math.round(thumbnail.collapse_fraction * spacing);

            const x1 = box.x1;
            const x2 = x1 + thumbnailWidth;

            if (i === this._dropPlaceholderPos) {
                let [, placeholderHeight] = this._dropPlaceholder.get_preferred_height(-1);
                childBox.x1 = x1;
                childBox.x2 = x2;

                if (rtl) {
                    childBox.y2 = box.y2 - Math.round(y);
                    childBox.y1 = box.y2 - Math.round(y + placeholderHeight);
                } else {
                    childBox.y1 = Math.round(y);
                    childBox.y2 = Math.round(y + placeholderHeight);
                }

                this._dropPlaceholder.allocate(childBox);

                Meta.later_add(Meta.LaterType.BEFORE_REDRAW, () => {
                    this._dropPlaceholder.show();
                });
                y += placeholderHeight + spacing;
            }

            // We might end up with thumbnailWidth being something like 99.33
            // pixels. To make this work and not end up with a gap at the end,
            // we need some thumbnails to be 99 pixels and some 100 pixels width;
            // we compute an actual scale separately for each thumbnail.
            const y1 = Math.round(y);
            const y2 = Math.round(y + thumbnailHeight);
            const roundedHScale = (y2 - y1) / portholeHeight;

            // Allocating a scaled actor is funny - x1/y1 correspond to the origin
            // of the actor, but x2/y2 are increased by the *unscaled* size.
            if (rtl) {
                childBox.y2 = box.y2 - y1;
                childBox.y1 = box.y2 - (y1 + thumbnailHeight);
            } else {
                childBox.y1 = y1;
                childBox.y2 = y1 + thumbnailHeight;
            }
            childBox.x1 = x1;
            childBox.x2 = x1 + thumbnailWidth;

            thumbnail.setScale(roundedHScale, roundedVScale);
            thumbnail.allocate(childBox);

            if (i === indicatorUpperWs) {
                indicatorUpperY1 = childBox.y1;
                indicatorUpperY2 = childBox.y2;
            }
            if (i === indicatorLowerWs) {
                indicatorLowerY1 = childBox.y1;
                indicatorLowerY2 = childBox.y2;
            }

            // We round the collapsing portion so that we don't get thumbnails resizing
            // during an animation due to differences in rounded, but leave the uncollapsed
            // portion unrounded so that non-animating we end up with the right total
            y += thumbnailHeight - Math.round(thumbnailHeight * thumbnail.collapse_fraction);
        }

        childBox.x1 = box.x1;
        childBox.x2 = box.x1 + thumbnailWidth;

        const indicatorY1 = indicatorLowerY1 +
            (indicatorUpperY1 - indicatorLowerY1) * (indicatorValue % 1);
        const indicatorY2 = indicatorLowerY2 +
            (indicatorUpperY2 - indicatorLowerY2) * (indicatorValue % 1);

        childBox.y1 = indicatorY1 - indicatorTopFullBorder;
        childBox.y2 = indicatorY2 + indicatorBottomFullBorder;
        childBox.x1 -= indicatorLeftFullBorder;
        childBox.x2 += indicatorRightFullBorder;
        this._indicator.allocate(childBox);
    },

    _updateShouldShow: function() {
        // set current workspace indicator border radius
        //this._indicator.set_style('border-radius: 8px;');

        const shouldShow = SHOW_WS_SWITCHER;
        if (this._shouldShow === shouldShow)
            return;

        this._shouldShow = shouldShow;
        this.notify('should-show');
    }
}

//------- overviewControls --------------------------------

// ControlsManager

var ControlsManagerOverride = {
    // this function overrides Main.overview._overview._controls._update, but in reality the original code is being executed
    /*_update: function() {
        const params = this._stateAdjustment.getStateTransitionParams();

        const fitMode = Util.lerp(
            this._getFitModeForState(params.initialState),
            this._getFitModeForState(params.finalState),
            params.progress);

        const { fitModeAdjustment } = this._workspacesDisplay;
        fitModeAdjustment.value = fitMode;

        this._updateThumbnailsBox();
        this._updateAppDisplayVisibility(params);
    }*/

    // this function has duplicate in WorkspaceView so we use one function for both to avoid issues with syncing them
    _getFitModeForState: function(state) {
        return _getFitModeForState(state);
    },

    _updateThumbnailsBox: function() {
        const { shouldShow } = this._thumbnailsBox;
        const thumbnailsBoxVisible = shouldShow;
        this._thumbnailsBox.visible = thumbnailsBoxVisible;

        // this call should be directly in _update(), but we cannot replace it
        // _update() overrides Main.overview._overview._controls._update, but in reality the original code is being executed instead
        this._updateWorkspacesDisplay();
    },

    // this function is pure addition to the original code and handles wsDisp transition to APP_GRID view
    _updateWorkspacesDisplay: function() {
        const { initialState, finalState, progress } = this._stateAdjustment.getStateTransitionParams();
        const { searchActive } = this._searchController;

        const paramsForState = s => {
            let opacity;
            switch (s) {
            case ControlsState.HIDDEN:
            case ControlsState.WINDOW_PICKER:
                opacity = 255;
                break;
            case ControlsState.APP_GRID:
                opacity = 0;
                break;
            default:
                opacity = 255;
                break;
            }
            return { opacity };
        };

        let initialParams = paramsForState(initialState);
        let finalParams = paramsForState(finalState);

        let opacity = Math.round(Util.lerp(initialParams.opacity, finalParams.opacity, progress));

        let workspacesDisplayVisible = (opacity != 0) && !(searchActive);

        if ((WS_ANIMATION !== 1) || !SHOW_WS_SWITCHER) {
            this._workspacesDisplay.opacity = opacity;
        } else if (!SHOW_WS_SWITCHER_BG) {
            // fade out ws wallpaper during transition to ws switcher if ws switcher background disabled
            this._workspacesDisplay._workspacesViews[global.display.get_primary_monitor()]._workspaces[this._workspaceAdjustment.value]._background.opacity = opacity;
        }

        this._appDisplay.opacity = 255 - opacity;

        // workspacesDisplay needs to go off screen in APP_GRID state, otherwise it blocks DND operations within the App Display
        // but the 'visibile' property ruins transition animation and breakes workspace control
        // scale_y = 0 hides the object but without collateral damage
        this._workspacesDisplay.scale_y = (progress == 1 && finalState == ControlsState.APP_GRID) ? 0 : 1;
        this._workspacesDisplay.setPrimaryWorkspaceVisible(workspacesDisplayVisible);
    }
}

//-------ControlsManagerLayout-----------------------------

var ControlsManagerLayoutOverride = {
    _computeWorkspacesBoxForState: function(state, box, workAreaBox, dashHeight, thumbnailsWidth) {
        const workspaceBox = box.copy();
        let [width, height] = workspaceBox.get_size();
        const { x1: startX, y1: startY } = workAreaBox;
        const { spacing } = this;
        //const { expandFraction } = this._workspacesThumbnails;

        const dash = Main.overview.dash;
        // including Dash to Dock and clones properties for compatibility
        const dashToDock = dash._isHorizontal !== undefined;
        if (dashToDock) {
            dashHeight = dash.height;
            // this is compensation for a bug relative to DtD bottom non-inteli hide position
            // when workspace box width is caluculated well, but output width is bigger, although if you read the width, you get the originally calculated value
            if (dash._isHorizontal && dash._position === 2) {
                height -= dash.height
            }
        }

        const dashPosition = dash._position;
        const DASH_VERTICAL = [1, 3].includes(dash._position);
        const DASH_TOP = dash._position === 0 && dash.visible;

        const WS_TMB_LEFT = this._workspacesThumbnails._positionLeft;

        let wWidth;
        let wHeight;
        let wsBoxY;

        switch (state) {
        case ControlsState.HIDDEN:
            workspaceBox.set_origin(...workAreaBox.get_origin());
            workspaceBox.set_size(...workAreaBox.get_size());
            break;
        case ControlsState.WINDOW_PICKER:
        case ControlsState.APP_GRID:
            if ((WS_ANIMATION === 1) && SHOW_WS_SWITCHER && state === ControlsState.APP_GRID) {
                workspaceBox.set_origin(...this._workspacesThumbnails.get_position());
                workspaceBox.set_size(...this._workspacesThumbnails.get_size());
            } else {
                dashHeight = dash.visible ? dashHeight : 0;
                wWidth = width
                            - spacing
                            - (DASH_VERTICAL ? dash.width + spacing : spacing)
                            - (thumbnailsWidth ? thumbnailsWidth + spacing : 0)
                            - 2 * spacing;
                wHeight = height
                            - (DASH_VERTICAL ? 4 * spacing : (dashHeight ? dashHeight + spacing : 4 * spacing))
                            - 3 * spacing;
                const ratio = width / height;
                let wRatio = wWidth / wHeight;
                let scale = ratio / wRatio;

                if (scale > 1) {
                    wHeight = Math.round(wHeight / scale);
                    wWidth = Math.round(wHeight * ratio);
                } else {
                    wWidth = Math.round(wWidth * scale);
                    wHeight = Math.round(wWidth / ratio);
                }

                let xOffset = 0;
                let yOffset = 0;

                yOffset = DASH_TOP ? spacing : (((height - wHeight - (!DASH_VERTICAL ? dashHeight : 0)) / 3));

                // move the workspace box to the middle of the screen, if possible
                const centeredBoxX = (width - wWidth) / 2;
                xOffset = Math.min(centeredBoxX, width - wWidth - thumbnailsWidth - 2 * spacing - 
                    (((DASH_POSITION === 2 && [1, 3].includes(WS_TMB_POSITION)) || (DASH_POSITION === 3 && [0, 2].includes(WS_TMB_POSITION))) ? dash.width + spacing : 0));

                this._xAlignCenter = false;
                if (xOffset !== centeredBoxX) { // in this case xOffset holds max possible wsBoxX coordinance
                    xOffset = ((dashPosition === 3 && dash.visible) ? dash.width + spacing : 0) + (thumbnailsWidth && WS_TMB_LEFT ? thumbnailsWidth + spacing : 0)
                            + (width - wWidth - 2 * spacing - thumbnailsWidth - ((DASH_VERTICAL && dash.visible) ? dash.width + spacing : 0)) / 2;
                } else {
                    this._xAlignCenter = true;
                }

                const wsBoxX = Math.round(xOffset);
                wsBoxY = Math.round(startY + yOffset + ((dashHeight && DASH_TOP) ? dashHeight : spacing)/* + (searchHeight ? searchHeight + spacing : 0)*/);
                workspaceBox.set_origin(Math.round(wsBoxX), Math.round(wsBoxY));
                workspaceBox.set_size(wWidth, wHeight);
            }
        }

        return workspaceBox;
    },

    _getAppDisplayBoxForState: function(state, box, workAreaBox, /*searchHeight,*/ dashWidth, dashHeight, appGridBox, thumbnailsWidth) {
        const [width] = box.get_size();
        const { x1: startX } = workAreaBox;
        const { y1: startY } = workAreaBox;
        const height = workAreaBox.get_height();
        const appDisplayBox = new Clutter.ActorBox();
        const { spacing } = this;


        const WS_TMB_LEFT = this._workspacesThumbnails._positionLeft;
        const dash = Main.overview.dash;
        const dashPosition = dash._position;

        const appDisplayX = CENTER_APP_GRID ? spacing + thumbnailsWidth : (dashPosition === 3 ? dash.width + spacing : 0) + (WS_TMB_LEFT ? thumbnailsWidth : 0) + spacing;
        const appDisplayY = startY + (dashPosition === DashPosition.TOP ? dashHeight + spacing : spacing);

        const adWidth = CENTER_APP_GRID ? width - 2 * (thumbnailsWidth + spacing) : width - ([1, 3].includes(dashPosition) ? dashWidth + 2 * spacing : 2 * spacing) - thumbnailsWidth - spacing;
        const adHeight = height - ([0, 2].includes(dashPosition) ? dashHeight + 3 * spacing : 2 * spacing);
        switch (state) {
        case ControlsState.HIDDEN:
        case ControlsState.WINDOW_PICKER:
            // 1 - left, 2 - right, 3 - bottom
            switch (APP_GRID_ANIMATION) {
            case 0:
                appDisplayBox.set_origin(appDisplayX, appDisplayY);
                break;
            case 1:
                appDisplayBox.set_origin(startX + width, appDisplayY);
                break;
            case 2:
                appDisplayBox.set_origin(startX - adWidth, appDisplayY);
                break;
            case 3:
                appDisplayBox.set_origin(appDisplayX, workAreaBox.y2);
                break;
            }
            break;
        case ControlsState.APP_GRID:
            appDisplayBox.set_origin(appDisplayX, appDisplayY);
            break;
        }

        appDisplayBox.set_size(adWidth, adHeight);
        return appDisplayBox;
    },

    vfunc_allocate: function(container, box) {
        const childBox = new Clutter.ActorBox();

        const { spacing } = this;

        const monitor = Main.layoutManager.findMonitorForActor(this._container);
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const startX = workArea.x - monitor.x;
        const startY = workArea.y - monitor.y;
        const workAreaBox = new Clutter.ActorBox();
        workAreaBox.set_origin(startX, startY);
        workAreaBox.set_size(workArea.width, workArea.height);
        box.y1 += startY;
        box.x1 += startX;
        const [width, height] = box.get_size();
        let availableHeight = height;

        // Dash
        const maxDashHeight = Math.round(box.get_height() * DASH_MAX_SIZE_RATIO);
        const maxDashWidth = maxDashHeight * 0.8;
        let dashHeight = 0;
        let dashWidth = 0;

        const wsTmbPosition = this._workspacesThumbnails.visible && WS_TMB_POSITION;
        const WS_TMB_FULL_HEIGHT = wsTmbPosition > 1;

        let dashPosition = DASH_POSITION;
        const DASH_CENTER_WS = CENTER_DASH_WS;
        let DASH_TOP = dashPosition === 0;
        this._dash._position = dashPosition;

        let DASH_VERTICAL = [1, 3].includes(dashPosition);
        // dash cloud be overriden by the Dash to Dock clone
        // Dash to Dock has property _isHorizontal
        const dash = Main.overview.dash;
        if (dash._isHorizontal !== undefined) {
            dashHeight = dash.height;
            dashWidth = dash.width;
            dashPosition = dash._position;
            DASH_TOP = dash._position === 0;
            DASH_VERTICAL = [1, 3].includes(dashPosition);
            this._dash.allocate(childBox);
        } else if (this._dash.visible) {
            // default dock
            if (DASH_VERTICAL) {
                this._dash.setMaxSize(maxDashWidth, height);
                [, dashWidth] = this._dash.get_preferred_width(height);
                [, dashHeight] = this._dash.get_preferred_height(dashWidth);
                dashWidth = Math.min(dashWidth, maxDashWidth);
                dashHeight = Math.min(dashHeight, height - 2 * spacing);

            } else if (!WS_TMB_FULL_HEIGHT) {
                    this._dash.setMaxSize(width, maxDashHeight);
                [, dashHeight] = this._dash.get_preferred_height(width);
                [, dashWidth] = this._dash.get_preferred_width(dashHeight);
                dashHeight = Math.min(dashHeight, maxDashHeight);
                dashWidth = Math.min(dashWidth, width - 2 * spacing);
            }
        }

        // 0 - left, 1 - right, 2 - left hull-height, 3 - right full-height
        const WS_TMB_RIGHT = [1, 3].includes(wsTmbPosition);
        availableHeight -= DASH_VERTICAL ? 0 : dashHeight + spacing;

        // Workspace Thumbnails
        let wsTmbWidth = 0;
        let thumbnailsHeight = 0;

        if (this._workspacesThumbnails.visible) {
            const REDUCE_WS_TMB_IF_NEEDED = this._searchController._searchActive && CENTER_SEARCH_VIEW;

            const { expandFraction } = this._workspacesThumbnails;
            const dashHeightReservation = !WS_TMB_FULL_HEIGHT ? dashHeight : 0;
            thumbnailsHeight = WS_TMB_FULL_HEIGHT
                                ? height - 2 * spacing
                                : height - 3 * spacing - (DASH_VERTICAL ? 0 : dashHeightReservation + spacing);

            wsTmbWidth = this._workspacesThumbnails.get_preferred_custom_width(thumbnailsHeight)[0];
            wsTmbWidth = Math.round(Math.min(
                wsTmbWidth * expandFraction,
                width * WorkspaceThumbnail.MAX_THUMBNAIL_SCALE
            ));

            if (REDUCE_WS_TMB_IF_NEEDED) {
                const searchAllocation = this._searchController._searchResults._content.allocation;
                const searchWidth = searchAllocation.x2 - searchAllocation.x1;
                wsTmbWidth = Math.clamp((width - searchWidth) / 2 - spacing, width * 0.05, wsTmbWidth);
            }

            thumbnailsHeight = Math.round(Math.min(this._workspacesThumbnails.get_preferred_custom_height(wsTmbWidth)[1], thumbnailsHeight));

            let wsTmbX;
            if (WS_TMB_RIGHT) {
                wsTmbX = width - (dashPosition === 1 ? dashWidth : 0) - spacing - wsTmbWidth;
                this._workspacesThumbnails._positionLeft = false;
            } else {
                wsTmbX = (dashPosition === 3 ? dashWidth + spacing : 0) + spacing;
                this._workspacesThumbnails._positionLeft = true;
            }

            let wstOffset = (height - spacing - thumbnailsHeight - spacing - (DASH_VERTICAL ? 0 : dashHeightReservation)) / 2;
            wstOffset = wstOffset - WS_TMB_POSITION_ADJUSTMENT * wstOffset;
            let wsTmbY = startY + ((dashHeightReservation && DASH_TOP) ? dashHeight + spacing : spacing) + wstOffset;

            childBox.set_origin(wsTmbX, wsTmbY);
            childBox.set_size(wsTmbWidth, thumbnailsHeight);

            this._workspacesThumbnails.allocate(childBox);
        }


        if (this._dash.visible) {
            const wMaxWidth = width - spacing - wsTmbWidth - 2 * spacing - (DASH_VERTICAL ? dashWidth + spacing : 0);
            if (WS_TMB_FULL_HEIGHT && !DASH_VERTICAL) {
                this._dash.setMaxSize(wMaxWidth, maxDashHeight);
                [, dashHeight] = this._dash.get_preferred_height(wMaxWidth);
                [, dashWidth] = this._dash.get_preferred_width(dashHeight);
                dashHeight = Math.min(dashHeight, maxDashHeight);
                dashWidth = Math.min(dashWidth, wMaxWidth);
            }

            let dashX, dashY, offset;
            if (dashPosition === DashPosition.RIGHT)
                dashX = width - dashWidth;
            else if (dashPosition === DashPosition.LEFT) {
                dashX = 0;
            }
            else if (dashPosition === DashPosition.TOP)
                dashY = startY;
            else
                dashY = startY + height - dashHeight;

            if (!DASH_VERTICAL) {
                offset = (width - ((WS_TMB_FULL_HEIGHT || DASH_CENTER_WS) ? wsTmbWidth + spacing : 0) - dashWidth - 2 * spacing) / 2;
                offset = offset - DASH_POSITION_ADJUSTMENT * offset;
                dashX = offset;

                if (WS_TMB_FULL_HEIGHT || DASH_CENTER_WS) {
                    if (WS_TMB_RIGHT) {
                        dashX = Math.min(dashX, width - spacing - dashWidth - (wsTmbWidth ? wsTmbWidth + 2 * spacing : spacing));
                    } else {
                        dashX = (wsTmbWidth ? wsTmbWidth + 2 * spacing : spacing) + offset;
                        dashX = Math.max(dashX, wsTmbWidth ? wsTmbWidth + 2 * spacing : spacing);
                        dashX = Math.min(dashX, width - dashWidth - spacing);
                    }
                }
            } else {
                const offset = Math.max(0, (height - dashHeight - 2 * spacing) / 2);
                dashY = startY + offset - DASH_POSITION_ADJUSTMENT * offset;
            }

            childBox.set_origin(dashX, dashY);
            childBox.set_size(dashWidth, dashHeight);
            this._dash.allocate(childBox);
        }


        // Workspaces
        let params = [box, workAreaBox, dashHeight, wsTmbWidth];
        const transitionParams = this._stateAdjustment.getStateTransitionParams();

        // Update cached boxes
        for (const state of Object.values(ControlsState)) {
            this._cachedWorkspaceBoxes.set(
                state, this._computeWorkspacesBoxForState(state, ...params));
        }

        let workspacesBox;
        if (!transitionParams.transitioning) {
            workspacesBox = this._cachedWorkspaceBoxes.get(transitionParams.currentState);
        } else {
            const initialBox = this._cachedWorkspaceBoxes.get(transitionParams.initialState);
            const finalBox = this._cachedWorkspaceBoxes.get(transitionParams.finalState);
            workspacesBox = initialBox.interpolate(finalBox, transitionParams.progress);
        }

        this._workspacesDisplay.allocate(workspacesBox);

        // Search entry
        const searchXoffset = spacing + (WS_TMB_RIGHT ? 0 : wsTmbWidth + spacing);
        let [searchHeight] = this._searchEntry.get_preferred_height(width - wsTmbWidth);

        // Y possition under top Dash
        let searchEntryX, searchEntryY;
        if (DASH_TOP) {
            searchEntryY = startY + (DASH_VERTICAL ? spacing : dashHeight - spacing);
        } else {
            searchEntryY = startY + spacing;
        }

        searchEntryX = startX + searchXoffset;
        const searchEntryWidth = this._xAlignCenter ? width : width - 2 * spacing - wsTmbWidth; // xAlignCenter is given by wsBox

        if (CENTER_SEARCH_VIEW) {
            childBox.set_origin(0, searchEntryY);
            childBox.set_size(width, searchHeight);
        } else {
            childBox.set_origin(this._xAlignCenter ? 0 : searchEntryX, searchEntryY);
            childBox.set_size(this._xAlignCenter ? width : searchEntryWidth, searchHeight);
        }

        this._searchEntry.allocate(childBox);

        availableHeight -= searchHeight + spacing;

        // AppDisplay - state, box, workAreaBox, searchHeight, dashHeight, appGridBox, wsTmbWidth
        if (this._appDisplay.visible) {
            const workspaceAppGridBox =
                this._cachedWorkspaceBoxes.get(ControlsState.WINDOW_PICKER);

            params = [box, workAreaBox, /*searchHeight,*/ dashWidth, dashHeight, workspaceAppGridBox, wsTmbWidth];
            let appDisplayBox;
            if (!transitionParams.transitioning) {
                appDisplayBox =
                    this._getAppDisplayBoxForState(transitionParams.currentState, ...params);
            } else {
                const initialBox =
                    this._getAppDisplayBoxForState(transitionParams.initialState, ...params);
                const finalBox =
                    this._getAppDisplayBoxForState(transitionParams.finalState, ...params);

                appDisplayBox = initialBox.interpolate(finalBox, transitionParams.progress);
            }
            this._appDisplay.allocate(appDisplayBox);
        }

        // Search
        let searchWidth = width;
        if (CENTER_SEARCH_VIEW) {
            childBox.set_origin(0, startY + (DASH_TOP ? dashHeight + spacing : spacing) + searchHeight + spacing);
        } else {
            childBox.set_origin(this._xAlignCenter ? 0 : searchXoffset, startY + (DASH_TOP ? dashHeight + spacing : spacing) + searchHeight + spacing);
            searchWidth = this._xAlignCenter ? width : width - 2 * spacing - wsTmbWidth;
        }

        childBox.set_size(searchWidth, availableHeight);
        this._searchController.allocate(childBox);

        this._runPostAllocation();
    }
}

// ------ Workspace -----------------------------------------------------------------
var WorkspaceLayoutOverride = {
    // this fixes wrong size and position calculation of window clones while moving overview to the next (+1) workspace if vertical ws orintation is enabled in GS
    _adjustSpacingAndPadding: function(rowSpacing, colSpacing, containerBox) {
        if (this._sortedWindows.length === 0)
            return [rowSpacing, colSpacing, containerBox];

        // All of the overlays have the same chrome sizes,
        // so just pick the first one.
        const window = this._sortedWindows[0];

        const [topOversize, bottomOversize] = window.chromeHeights();
        const [leftOversize, rightOversize] = window.chromeWidths();

        const oversize = Math.max(topOversize, bottomOversize, leftOversize, rightOversize);

        if (rowSpacing !== null)
            rowSpacing += oversize;
        if (colSpacing !== null)
            colSpacing += oversize;

        if (containerBox) {
            const vertical = global.workspaceManager.layout_rows === -1;

            const monitor = Main.layoutManager.monitors[this._monitorIndex];

            const bottomPoint = new Graphene.Point3D();
            if (vertical) {
                bottomPoint.x = containerBox.x2;
            } else {
                bottomPoint.y = containerBox.y2;
            }

            const transformedBottomPoint =
                this._container.apply_transform_to_point(bottomPoint);
            const bottomFreeSpace = vertical
                ? (monitor.x + monitor.height) - transformedBottomPoint.x
                : (monitor.y + monitor.height) - transformedBottomPoint.y;

            const [, bottomOverlap] = window.overlapHeights();

            if ((bottomOverlap + oversize) > bottomFreeSpace && !vertical) {
                containerBox.y2 -= (bottomOverlap + oversize) - bottomFreeSpace;
            }
        }

        return [rowSpacing, colSpacing, containerBox];
    }
}

//------ appDisplay --------------------------------------------------------------------------------

var BaseAppViewOverride  = {
    // this fixes dnd from appDisplay to workspace switcher if appDisplay is on page 1. weird bug, weird solution..
    _pageForCoords: function(x, y) {
        if (this._dragMonitor != null)
            return AppDisplay.SidePages.NONE;

        const rtl = this.get_text_direction() === Clutter.TextDirection.RTL;
        const { allocation } = this._grid;

        const [success, pointerX] = this._scrollView.transform_stage_point(x, y);
        if (!success)
            return AppDisplay.SidePages.NONE;

        if (pointerX < allocation.x1)
            return rtl ? AppDisplay.SidePages.NEXT : AppDisplay.SidePages.PREVIOUS;
        else if (pointerX > allocation.x2)
            return rtl ? AppDisplay.SidePages.PREVIOUS : AppDisplay.SidePages.NEXT;

        return AppDisplay.SidePages.NONE;
    }
}
