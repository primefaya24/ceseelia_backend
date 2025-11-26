/*
* Head
*/
export function generateHeadContent(): string {
    return "<meta charset='utf-8'><meta content='width=device-width, initial-scale=1' name='viewport'><link href='https://assets.awsfire.com/logo.ico' rel='icon' type='image/x-icon'><link rel='preconnect' href='https://fonts.googleapis.com'><link rel='preconnect' href='https://fonts.gstatic.com' crossorigin><link href='https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;500;600;700&family=Poppins:wght@400;600;700&family=Roboto:wght@400;500;700&display=swap' rel='stylesheet'><link rel='stylesheet' href='https://fonts.googleapis.com/icon?family=Material+Icons'><link crossorigin='anonymous' href='https://cdn.jsdelivr.net/npm/bootstrap@5.3.0-alpha1/dist/css/bootstrap.min.css' integrity='sha384-GLhlTQ8iRABdZLl6O3oVMWSktQOp6b7In1Zl3/Jr59b6EGGoI1aFkw7cmDA6j6gD' rel='stylesheet'><script src='https://ajax.googleapis.com/ajax/libs/jquery/3.6.3/jquery.min.js'></script><script src='/js/global.js' type='text/javascript'></script><link href='/css/global.css' rel='stylesheet' type='text/css'>";
}

/*
* Navbar
*/
function geNavbarProfileLink(userName: string, userAvatarUrl: string): string {
    const avatarUrl = userAvatarUrl.length === 0 ? "https://assets.awsfire.com/user_profile.png" : userAvatarUrl;
    return "<!-- Profile link --> <div class='col-3 h-100'> <div class='wrapper'> <div class='main-align-right no-select'> <a style='cursor: pointer;' href='/profile-overview'> <span class='app-navbar-link-no-animation' style='padding-right: 10px; padding-top: 10px; padding-bottom: 10px;'>" + userName +  "</span> <img alt='logo' class='app-navbar-avatar' src=" + avatarUrl + "> </a> </div> </div> </div>";
}

function geSideMenuProfileLink(userName: string, userAvatarUrl: string): string {
    const avatarUrl = userAvatarUrl.length === 0 ? "https://assets.awsfire.com/user_profile.png" : userAvatarUrl;
    return "<!-- Profile link --> <div class='no-select'> <a href='/profile-overview'> <div> <img alt='logo' class='app-navbar-avatar' src=" + avatarUrl + "> </div> <div class='app-navbar-link-no-animation app-navbar-avatar-user-name'>" + userName + "</div> </a> </div>";
}

export function generateNavbarContent(isLoggedIn: boolean = false, userName: string, userAvatarUrl: string, forumLink: string, blogLink: string, newsLink: string,
                                      navBarBackground: 'white' | 'blue' = 'white'): string {
    // Side menu HTML
    const sideMenuOpening = "<div id='sideMenu' class='box-even-shadow'> <div class='side-menu-header'> <div class='row h-100'> <div class='col-8' style='padding: 0'>";
    const sideMenuMiddle = "</div> <!-- Close --> <div class='col-4' style='padding: 0'> <img id='closeSideMenuButton' alt='close' class='app-navbar-x' src='https://assets.awsfire.com/x.png'> </div> </div> <!-- Side menu links --> <div class='row'> <a class='app-navbar-link-no-animation' href='/forum-table'><div class='row side-menu-link-div'>Forum</div></a> <a class='app-navbar-link-no-animation' href='/blog'><div class='row side-menu-link-div'>Blog</div></a> <a class='app-navbar-link-no-animation' href='/news'><div class='row side-menu-link-div'>News</div></a> </div>";
    const sideMenuAuthLinks = "<!-- Auth links --> <div class='row' style='text-align: center; margin-top: 40px'> <a class='app-sidebar-button-bg-transparent' href='/register'>Register</a> <a class='app-sidebar-button' href='/login' style='margin-top: 10px'>Login</a> </div>";
    const sideMenuClosing = "</div> </div> <!-- Side menu dimmed layer --> <div id='dimmedBackground' class='dimmed-layer'></div>";
    let sideMenuHTML = "";
    if (isLoggedIn) {
        sideMenuHTML = sideMenuOpening + geSideMenuProfileLink(userName, userAvatarUrl) +  sideMenuMiddle + sideMenuClosing;
    } else {
        sideMenuHTML = sideMenuOpening + sideMenuMiddle + sideMenuAuthLinks + sideMenuClosing;
    }

    // Entire HTML
    const navBarBackgroundClasses = navBarBackground === 'white' ? "app-navbar-container-white box-even-shadow" : "app-navbar-container-blue";
    const opening = "<div id='appNavbarContainer' class='" + navBarBackgroundClasses + "'> <!-- Desktop --> <div class='app-navbar-desktop container h-100'> <div class='row h-100'> <div class='col-3 h-100'> <div class='wrapper'> <!-- Logo + app name --> <div class='main-align-left no-select'> <a style='cursor: pointer;' href='/public'> <img alt='logo' class='app-logo' src='https://assets.awsfire.com/logo.png'> <div class='app-name'> <span class='app-name-s1'>Cognitive</span> <span class='app-name-s2'>Kernel</span> </div> </a> </div> </div> </div> <div class='col-6 h-100'> <div class='wrapper'> <!-- Navbar links --> <div class='main no-select'> <a class='app-navbar-link' href='" + forumLink + "' onclick=''>Forum</a> <a class='app-navbar-link app-navbar-link-middle' href='" + blogLink + "' onclick=''>Blog</a> <a class='app-navbar-link app-navbar-link-middle' href='" + newsLink + "' onclick=''>News</a> </div> </div> </div>\n";
    const authLinks = "<!-- Auth links --> <div class='col-3 h-100'> <div class='wrapper'> <div class='main-align-right'> <div class='d-inline-block no-select'> <a class='app-navbar-link' href='/register' style='margin-right: 18px'>Register</a> <a class='app-navbar-button' href='/login'>Login</a> </div> </div> </div> </div>";
    const closing = "</div> </div> <!-- Mobile --> <div class='app-navbar-mobile container h-100'> <div class='row h-100'> <div class='col-8 h-100'> <div class='wrapper'> <div class='main-align-left no-select'> <a style='cursor: pointer;' href='/public'> <img alt='logo' class='app-logo' src='https://assets.awsfire.com/logo.png'> <div class='app-name'> <span class='app-name-s1'>aws</span><span class='app-name-s2'>Fire</span> </div> </a> </div> </div> </div> <div class='col-4 h-100'> <div class='wrapper'> <div class='main-align-right'> <div id='openSideMenuButton' class='app-navbar-menu-icon no-select'> <div class='wrapper'> <div class='main'> <div class='app-navbar-menu-icon-line'></div> <div class='app-navbar-menu-icon-line app-navbar-menu-icon-line-margin'></div> <div class='app-navbar-menu-icon-line app-navbar-menu-icon-line-margin'></div> </div> </div> </div> </div> </div> </div> </div> </div> </div>\n";
    if (isLoggedIn) {
        return sideMenuHTML + opening + geNavbarProfileLink(userName, userAvatarUrl) + closing;
    } else {
        return sideMenuHTML + opening + authLinks + closing;
    }
}

/*
* Footer
*/
export function generateFooterContent(): string {
    return "<div class='app-footer'> <div class='container app-footer-container'> <div class='row'> <!-- Logo & name --> <div class='col-12 col-sm-12 col-md-12 col-lg-4 app-footer-section'> <a style='cursor: pointer;' href='/public'> <img alt='logo' class='app-logo' src='https://assets.awsfire.com/logo.png'> <div class='app-name'> <span class='app-name-s1'>aws</span><span class='app-name-s2'>Fire</span> </div> </a> <p class='app-footer-promo-text'> Creating global applications has never been easier with Amazon's cutting-edge cloud infrastructure. Join our community and start building your career! </p> </div> <!-- Main links  --> <div class='col-4 col-sm-6 col-md-6 col-lg-4 app-footer-section'> <div class='no-select app-footer-dynamic-text-centering'> <a class='app-footer-link' href='/forum-table'>Forum</a> </div> <div class='app-footer-link-div no-select app-footer-dynamic-text-centering'> <a class='app-footer-link' href='/blog'>Blog</a> </div> <div class='app-footer-link-div no-select app-footer-dynamic-text-centering'> <a class='app-footer-link' href='/news'>News</a> </div> </div> <!-- Secondary links  --> <div class='col-8 col-sm-6 col-md-6 col-lg-4 app-footer-section'> <div class='no-select app-footer-dynamic-text-centering'> <a class='app-footer-link' href='/privacy-policy'>Privacy Policy</a> </div> <div class='app-footer-link-div no-select app-footer-dynamic-text-centering'> <a class='app-footer-link' href='/terms-and-conditions'>Terms &amp; Conditions</a> </div> <div class='app-footer-link-div no-select app-footer-dynamic-text-centering'> <a class='app-footer-link' href='/contact-us'>Contact Us</a> </div> </div> </div> </div> <!-- Copyright message  --> <div class='app-footer-copy-right-div'> <div class='wrapper'> <div class='main'> &copy; <script>document.write(/\\d{4}/.exec(Date())[0])</script> awsFire. All rights reserved. </div> </div> </div> </div>";
}

/*
* Bootstrap
*/
export function generateBootstrapContent(): string {
    return "<script crossorigin='anonymous' integrity='sha384-oBqDVmMz9ATKxIep9tiCxS/Z9fNfEXiDAYTujMAeBAsjFuCZSmKbSSUnQlmh/jp3' src='https://cdn.jsdelivr.net/npm/@popperjs/core@2.11.6/dist/umd/popper.min.js'></script><script crossorigin='anonymous' integrity='sha384-mQ93GR66B00ZXjt0YO5KlohRA5SY2XofN4zfuZxLkoj1gXtW8ANNCe9d5Y3eG5eD' src='https://cdn.jsdelivr.net/npm/bootstrap@5.3.0-alpha1/dist/js/bootstrap.min.js'></script>";
}